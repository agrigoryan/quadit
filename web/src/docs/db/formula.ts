// The expression language of formula columns, worked out in the browser so
// cells update at once. A faithful port of internal/formula/formula.go: the
// same grammar, functions, messages and edge cases, so both sides agree.
//
//   if(prop("Done"), "shipped", concat(prop("Owner"), " is on it"))
//   round(prop("Points") * 1.5, 1)
//   dateDiff(prop("Due"), today(), "days") < 3 and not prop("Done")
//
// Values are numbers, text, true/false, lists and empty (null).

import { callFunction } from "@/docs/db/formula-fns";
import { compareText, formulaText, isEmpty, num, quote, truthy } from "@/docs/db/formula-values";

export { FUNCTIONS } from "@/docs/db/formula-fns";

export type Value = number | string | boolean | null | Value[] | { [key: string]: unknown };

export interface Env {
  /** A property of the row by name; null when it is empty. */
  prop?: (name: string) => Value;
  now?: Date;
}

interface Token {
  kind: "num" | "str" | "id" | "op";
  text: string;
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";

function lex(s: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < s.length;) {
    const c = s.charAt(i);
    if (c === " " || c === "\t" || c === "\n") {
      i++;
    } else if (isDigit(c) || (c === "." && isDigit(s.charAt(i + 1)))) {
      let j = i;
      while (j < s.length && (isDigit(s.charAt(j)) || s.charAt(j) === ".")) j++;
      out.push({ kind: "num", text: s.slice(i, j) });
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      while (j < s.length && s.charAt(j) !== c) {
        if (s.charAt(j) === "\\" && j + 1 < s.length) j++;
        text += s.charAt(j);
        j++;
      }
      if (j >= s.length) throw new Error("a text value is missing its closing quote");
      out.push({ kind: "str", text });
      i = j + 1;
    } else if (isLetter(c)) {
      let j = i;
      while (j < s.length && (isLetter(s.charAt(j)) || isDigit(s.charAt(j)))) j++;
      out.push({ kind: "id", text: s.slice(i, j) });
      i = j;
    } else {
      const two = s.slice(i, i + 2);
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
        out.push({ kind: "op", text: two });
        i += 2;
      } else {
        if (!"+-*/%<>(),!=".includes(c)) throw new Error(`unexpected character ${quote(c)}`);
        out.push({ kind: "op", text: c });
        i++;
      }
    }
  }
  return out;
}

class Parser {
  pos = 0;
  constructor(
    private toks: Token[],
    private env: Env,
    private now: Date,
  ) {}

  get done() {
    return this.pos >= this.toks.length;
  }
  get next(): Token | undefined {
    return this.toks[this.pos];
  }

  private peek(...texts: string[]): boolean {
    const tok = this.toks[this.pos];
    return !!tok && tok.kind !== "str" && texts.includes(tok.text);
  }

  private take(...texts: string[]): string | null {
    if (!this.peek(...texts)) return null;
    return (this.toks[this.pos++] as Token).text;
  }

  or(): Value {
    let v = this.and();
    while (this.take("or", "||") !== null) {
      const r = this.and();
      v = truthy(v) || truthy(r);
    }
    return v;
  }

  private and(): Value {
    let v = this.cmp();
    while (this.take("and", "&&") !== null) {
      const r = this.cmp();
      v = truthy(v) && truthy(r);
    }
    return v;
  }

  private cmp(): Value {
    const l = this.add();
    const op = this.take("==", "=", "!=", "<", "<=", ">", ">=");
    if (op === null) return l;
    const c = compare(l, this.add());
    switch (op) {
      case "==":
      case "=":
        return c === 0;
      case "!=":
        return c !== 0;
      case "<":
        return c < 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
    }
    return c >= 0;
  }

  private add(): Value {
    let v = this.mul();
    for (;;) {
      const op = this.take("+", "-");
      if (op === null) return v;
      const r = this.mul();
      if (op === "+") {
        // Adding to text joins text.
        if (typeof v === "string" || typeof r === "string") v = formulaText(v) + formulaText(r);
        else v = num(v) + num(r);
      } else {
        v = num(v) - num(r);
      }
    }
  }

  private mul(): Value {
    let v = this.unary();
    for (;;) {
      const op = this.take("*", "/", "%");
      if (op === null) return v;
      const r = num(this.unary());
      // Every branch of an if() is worked out, so dividing by an empty cell
      // must give an empty cell, not an error for the whole row.
      if (op === "*") v = num(v) * r;
      else if (r === 0) v = null;
      else if (op === "/") v = num(v) / r;
      else v = num(v) % r;
    }
  }

  private unary(): Value {
    if (this.take("-") !== null) return -num(this.unary());
    if (this.take("not", "!") !== null) return !truthy(this.unary());
    return this.primary();
  }

  private primary(): Value {
    const tok = this.toks[this.pos];
    if (!tok) throw new Error("the formula ends too soon");
    this.pos++;
    switch (tok.kind) {
      case "num": {
        // Only digits and dots get here; more than one dot is not a number.
        if (tok.text.split(".").length > 2) throw new Error(`${quote(tok.text)} is not a number`);
        return Number.parseFloat(tok.text);
      }
      case "str":
        return tok.text;
      case "id": {
        if (tok.text === "true") return true;
        if (tok.text === "false") return false;
        if (tok.text === "empty" && !this.peek("(")) return null;
        if (this.take("(") === null) {
          throw new Error(`${quote(tok.text)} is not a value; to read a property write prop("${tok.text}")`);
        }
        const args: Value[] = [];
        while (!this.peek(")")) {
          args.push(this.or());
          if (this.take(",") === null) break;
        }
        if (this.take(")") === null) throw new Error(`${tok.text}( is missing its )`);
        return this.call(tok.text, args);
      }
    }
    if (tok.text === "(") {
      const v = this.or();
      if (this.take(")") === null) throw new Error("a ( is missing its )");
      return v;
    }
    throw new Error(`unexpected ${quote(tok.text)}`);
  }

  private call(name: string, a: Value[]): Value {
    return callFunction(name, a, this.env, this.now);
  }
}

function compare(l: Value, r: Value): number {
  if (isEmpty(l) && isEmpty(r)) return 0;
  if (typeof l === "string" && typeof r === "string") return compareText(l, r);
  if (typeof l === "boolean" && typeof r === "boolean") return l === r ? 0 : r ? -1 : 1;
  const a = num(l);
  const b = num(r);
  return a < b ? -1 : a > b ? 1 : 0;
}

export type Result = { value: Value; error?: undefined } | { error: string; value?: undefined };

/** Works out a formula. It never throws: what cannot be worked out comes back as an error to show. */
export function evalFormula(src: string, env: Env = {}): Result {
  try {
    const p = new Parser(lex(src), env, env.now ?? new Date());
    const value = p.or();
    if (!p.done) return { error: `unexpected ${quote(p.next?.text ?? "")}` };
    return { value };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
