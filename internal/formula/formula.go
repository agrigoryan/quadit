// Package formula evaluates the small expression language of formula
// columns in a database:
//
//	if(prop("Done"), "shipped", concat(prop("Owner"), " is on it"))
//	round(prop("Points") * 1.5, 1)
//	dateDiff(prop("Due"), today(), "days") < 3 and not prop("Done")
//
// Values are numbers, text, true/false and empty. A formula that cannot be
// worked out gives an error to show in the cell, never a crash.
package formula

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Env supplies what a formula can read.
type Env struct {
	// Prop returns a property of the row by name; nil when it is empty.
	Prop func(name string) any
	Now  time.Time
}

// Eval works out a formula.
func Eval(src string, env Env) (v any, err error) {
	defer func() {
		if r := recover(); r != nil {
			v, err = nil, fmt.Errorf("%v", r)
		}
	}()
	p := &parser{toks: lex(src), env: env}
	if env.Now.IsZero() {
		p.env.Now = time.Now()
	}
	v = p.or()
	if p.pos < len(p.toks) {
		return nil, fmt.Errorf("unexpected %q", p.toks[p.pos].text)
	}
	return v, nil
}

type token struct {
	kind string // num, str, id, op
	text string
}

func lex(s string) []token {
	var out []token
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			i++
		case c >= '0' && c <= '9' || (c == '.' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9'):
			j := i
			for j < len(s) && (s[j] >= '0' && s[j] <= '9' || s[j] == '.') {
				j++
			}
			out = append(out, token{"num", s[i:j]})
			i = j
		case c == '"' || c == '\'':
			j := i + 1
			var b strings.Builder
			for j < len(s) && s[j] != c {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				b.WriteByte(s[j])
				j++
			}
			if j >= len(s) {
				panic(errors.New("a text value is missing its closing quote"))
			}
			out = append(out, token{"str", b.String()})
			i = j + 1
		case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_':
			j := i
			for j < len(s) && (s[j] >= 'a' && s[j] <= 'z' || s[j] >= 'A' && s[j] <= 'Z' || s[j] >= '0' && s[j] <= '9' || s[j] == '_') {
				j++
			}
			out = append(out, token{"id", s[i:j]})
			i = j
		default:
			two := ""
			if i+1 < len(s) {
				two = s[i : i+2]
			}
			switch two {
			case "==", "!=", "<=", ">=", "&&", "||":
				out = append(out, token{"op", two})
				i += 2
			default:
				if !strings.ContainsRune("+-*/%<>(),!=", rune(c)) {
					panic(fmt.Errorf("unexpected character %q", string(c)))
				}
				out = append(out, token{"op", string(c)})
				i++
			}
		}
	}
	return out
}

type parser struct {
	toks []token
	pos  int
	env  Env
}

func (p *parser) peek(texts ...string) bool {
	if p.pos >= len(p.toks) || p.toks[p.pos].kind == "str" {
		return false
	}
	for _, t := range texts {
		if p.toks[p.pos].text == t {
			return true
		}
	}
	return false
}

func (p *parser) take(texts ...string) (string, bool) {
	if p.peek(texts...) {
		p.pos++
		return p.toks[p.pos-1].text, true
	}
	return "", false
}

func (p *parser) or() any {
	v := p.and()
	for {
		if _, ok := p.take("or", "||"); !ok {
			return v
		}
		r := p.and()
		v = truthy(v) || truthy(r)
	}
}

func (p *parser) and() any {
	v := p.cmp()
	for {
		if _, ok := p.take("and", "&&"); !ok {
			return v
		}
		r := p.cmp()
		v = truthy(v) && truthy(r)
	}
}

func (p *parser) cmp() any {
	l := p.add()
	op, ok := p.take("==", "=", "!=", "<", "<=", ">", ">=")
	if !ok {
		return l
	}
	r := p.add()
	c := compare(l, r)
	switch op {
	case "==", "=":
		return c == 0
	case "!=":
		return c != 0
	case "<":
		return c < 0
	case "<=":
		return c <= 0
	case ">":
		return c > 0
	}
	return c >= 0
}

func (p *parser) add() any {
	v := p.mul()
	for {
		op, ok := p.take("+", "-")
		if !ok {
			return v
		}
		r := p.mul()
		if op == "+" {
			if _, isStr := v.(string); isStr {
				v = text(v) + text(r)
				continue
			}
			if _, isStr := r.(string); isStr {
				v = text(v) + text(r)
				continue
			}
			v = num(v) + num(r)
		} else {
			v = num(v) - num(r)
		}
	}
}

func (p *parser) mul() any {
	v := p.unary()
	for {
		op, ok := p.take("*", "/", "%")
		if !ok {
			return v
		}
		r := num(p.unary())
		switch {
		case op == "*":
			v = num(v) * r
		case r == 0:
			// Every branch of an if() is worked out, so dividing by an empty
			// cell must give an empty cell, not an error for the whole row.
			v = nil
		case op == "/":
			v = num(v) / r
		default:
			v = math.Mod(num(v), r)
		}
	}
}

func (p *parser) unary() any {
	if _, ok := p.take("-"); ok {
		return -num(p.unary())
	}
	if _, ok := p.take("not", "!"); ok {
		return !truthy(p.unary())
	}
	return p.primary()
}

func (p *parser) primary() any {
	if p.pos >= len(p.toks) {
		panic(errors.New("the formula ends too soon"))
	}
	t := p.toks[p.pos]
	p.pos++
	switch t.kind {
	case "num":
		f, err := strconv.ParseFloat(t.text, 64)
		if err != nil {
			panic(fmt.Errorf("%q is not a number", t.text))
		}
		return f
	case "str":
		return t.text
	case "id":
		switch t.text {
		case "true":
			return true
		case "false":
			return false
		case "empty":
			if !p.peek("(") {
				return nil
			}
		}
		if _, ok := p.take("("); !ok {
			panic(fmt.Errorf("%q is not a value; to read a property write prop(\"%s\")", t.text, t.text))
		}
		var args []any
		for !p.peek(")") {
			args = append(args, p.or())
			if _, ok := p.take(","); !ok {
				break
			}
		}
		if _, ok := p.take(")"); !ok {
			panic(fmt.Errorf("%s( is missing its )", t.text))
		}
		return p.call(t.text, args)
	}
	if t.text == "(" {
		v := p.or()
		if _, ok := p.take(")"); !ok {
			panic(errors.New("a ( is missing its )"))
		}
		return v
	}
	panic(fmt.Errorf("unexpected %q", t.text))
}

// Functions lists what a formula can call, for the editor's help.
var Functions = []string{"prop", "if", "concat", "length", "lower", "upper", "contains", "empty", "round", "floor", "ceil", "abs", "min", "max", "sum",
	"toNumber", "format", "now", "today", "dateAdd", "dateDiff"}

func (p *parser) call(name string, a []any) any {
	arg := func(i int) any {
		if i >= len(a) {
			panic(fmt.Errorf("%s needs at least %d arguments", name, i+1))
		}
		return a[i]
	}
	switch name {
	case "prop":
		if p.env.Prop == nil {
			return nil
		}
		return p.env.Prop(text(arg(0)))
	case "if":
		if truthy(arg(0)) {
			return arg(1)
		}
		if len(a) > 2 {
			return a[2]
		}
		return nil
	case "concat":
		var b strings.Builder
		for _, v := range a {
			b.WriteString(text(v))
		}
		return b.String()
	case "length":
		return float64(len([]rune(text(arg(0)))))
	case "lower":
		return strings.ToLower(text(arg(0)))
	case "upper":
		return strings.ToUpper(text(arg(0)))
	case "contains":
		return strings.Contains(strings.ToLower(text(arg(0))), strings.ToLower(text(arg(1))))
	case "empty":
		return isEmpty(arg(0))
	case "round":
		scale := 1.0
		if len(a) > 1 {
			scale = math.Pow(10, num(a[1]))
		}
		return math.Round(num(arg(0))*scale) / scale
	case "floor":
		return math.Floor(num(arg(0)))
	case "ceil":
		return math.Ceil(num(arg(0)))
	case "abs":
		return math.Abs(num(arg(0)))
	case "min", "max", "sum":
		vals := flatten(a)
		if len(vals) == 0 {
			return nil
		}
		out := num(vals[0])
		for _, v := range vals[1:] {
			switch n := num(v); name {
			case "min":
				out = math.Min(out, n)
			case "max":
				out = math.Max(out, n)
			default:
				out += n
			}
		}
		return out
	case "toNumber":
		return num(arg(0))
	case "format":
		return text(arg(0))
	case "now":
		return p.env.Now.UTC().Format(time.RFC3339)
	case "today":
		return p.env.Now.UTC().Format("2006-01-02")
	case "dateAdd":
		t, ok := date(arg(0))
		if !ok {
			return nil
		}
		n := int(num(arg(1)))
		switch unit(a, 2) {
		case "weeks":
			t = t.AddDate(0, 0, 7*n)
		case "months":
			t = t.AddDate(0, n, 0)
		case "years":
			t = t.AddDate(n, 0, 0)
		default:
			t = t.AddDate(0, 0, n)
		}
		return t.Format("2006-01-02")
	case "dateDiff":
		x, ok1 := date(arg(0))
		y, ok2 := date(arg(1))
		if !ok1 || !ok2 {
			return nil
		}
		d := x.Sub(y)
		switch unit(a, 2) {
		case "hours":
			return math.Trunc(d.Hours())
		case "weeks":
			return math.Trunc(d.Hours() / 24 / 7)
		case "months":
			return float64((x.Year()-y.Year())*12 + int(x.Month()) - int(y.Month()))
		case "years":
			return float64(x.Year() - y.Year())
		}
		return math.Trunc(d.Hours() / 24)
	}
	panic(fmt.Errorf("unknown function %s; functions are: %s", name, strings.Join(Functions, ", ")))
}

func unit(a []any, i int) string {
	if i < len(a) {
		u := strings.ToLower(text(a[i]))
		if !strings.HasSuffix(u, "s") {
			u += "s"
		}
		return u
	}
	return "days"
}

func flatten(a []any) []any {
	var out []any
	for _, v := range a {
		if list, ok := v.([]any); ok {
			out = append(out, flatten(list)...)
		} else if !isEmpty(v) {
			out = append(out, v)
		}
	}
	return out
}

func isEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	}
	return false
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	}
	return !isEmpty(v)
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			if x == "" {
				return 0
			}
			panic(fmt.Errorf("%q is not a number", x))
		}
		return f
	}
	return 0
}

// Text shows a value the way a cell does.
func Text(v any) string { return text(v) }

func text(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = text(e)
		}
		return strings.Join(parts, ", ")
	}
	return fmt.Sprint(v)
}

func date(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok || s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02", time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func compare(l, r any) int {
	if isEmpty(l) && isEmpty(r) {
		return 0
	}
	_, ls := l.(string)
	_, rs := r.(string)
	if ls && rs {
		return strings.Compare(l.(string), r.(string))
	}
	if lb, ok := l.(bool); ok {
		if rb, ok := r.(bool); ok {
			if lb == rb {
				return 0
			}
			if rb {
				return -1
			}
			return 1
		}
	}
	a, b := num(l), num(r)
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
