// Holds each hand-written wire type to the row the server writes
// (rows.gen.ts, generated from the Go structs): the field names are the same
// both ways, a field is optional on both sides or on neither, and each
// field's type here is one the server's JSON type takes (a union of words
// may narrow a string; a number where the server sends a string fails).
// Types only: nothing here runs. `pnpm typecheck` fails on a drift, naming
// the row and the fields.
//
// A difference made on purpose is listed in Deliberate, with its reason,
// and nowhere else.

import type * as Web from "@/types/core";
import type * as Agents from "@/types/agents";
import type * as Automation from "@/types/automation";
import type * as Docs from "@/types/docs";
import type * as Server from "@/types/rows.gen";

/** The fields a web type has, or leaves out, on purpose: by row, each field with the reason. */
interface Deliberate {
  File: {
    url: "optional in the row, which stores no address; every file the server sends is given one (attachedFiles), and the app relies on it";
  };
  Doc: {
    created_seq: "absent on a page made here until the server's row arrives";
    updated_seq: "absent on a page made here until the server's row arrives";
    content_seq: "absent on a page made here until the server's row arrives";
  };
  DBProperty: { updated_seq: "absent on a property made here until the server's row arrives" };
  DBView: { updated_seq: "absent on a view made here until the server's row arrives" };
  DocVersion: { snapshot: "versions are listed without it; a version's content is read on its own" };
}

type Skipped<Name> = Name extends keyof Deliberate ? keyof Deliberate[Name] : never;

type OptionalKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never }[keyof T];

/** What is wrong between a web type and its server row; every member is never when nothing is. */
interface Drift<Name extends string, W, S> {
  row: Name;
  missing_in_web: Exclude<keyof S, keyof W | Skipped<Name>>;
  not_on_server: Exclude<keyof W, keyof S | Skipped<Name>>;
  optional_on_one_side: Exclude<
    Extract<Exclude<OptionalKeys<W>, OptionalKeys<S>> | Exclude<OptionalKeys<S>, OptionalKeys<W>>, keyof W & keyof S>,
    Skipped<Name>
  >;
  mistyped: {
    [K in Exclude<keyof W & keyof S, Skipped<Name>>]-?: Required<W>[K] extends Required<S>[K] ? never : K;
  }[Exclude<keyof W & keyof S, Skipped<Name>>];
  listed_but_on_neither_side: Exclude<Skipped<Name>, keyof W | keyof S>;
}

// A drift is shown spelt out, so that the error names the fields.
type Agrees<D> = [D[Exclude<keyof D, "row">]] extends [never] ? true : { [K in keyof D]: D[K] };
type Check<T extends true> = T;

export type RowsAgree = [
  Check<Agrees<Drift<"Workspace", Web.Workspace, Server.Workspace>>>,
  Check<Agrees<Drift<"User", Web.User, Server.User>>>,
  Check<Agrees<Drift<"Member", Web.Member, Server.Member>>>,
  Check<Agrees<Drift<"Project", Web.Project, Server.Project>>>,
  Check<Agrees<Drift<"Status", Web.Status, Server.Status>>>,
  Check<Agrees<Drift<"Label", Web.Label, Server.Label>>>,
  Check<Agrees<Drift<"Task", Web.Task, Server.Task>>>,
  Check<Agrees<Drift<"Relation", Web.Relation, Server.Relation>>>,
  Check<Agrees<Drift<"Comment", Web.Comment, Server.Comment>>>,
  Check<Agrees<Drift<"Option", Web.DecisionOption, Server.Option>>>,
  Check<Agrees<Drift<"Decision", Web.Decision, Server.Decision>>>,
  Check<Agrees<Drift<"File", Web.FileRow, Server.File>>>,
  Check<Agrees<Drift<"Attachment", Web.Attachment, Server.Attachment>>>,
  Check<Agrees<Drift<"AgentSession", Web.AgentSession, Server.AgentSession>>>,
  Check<Agrees<Drift<"Secret", Web.Secret, Server.Secret>>>,
  Check<Agrees<Drift<"Event", Web.FeedEvent, Server.Event>>>,
  Check<Agrees<Drift<"Result", Web.ChangeResult, Server.Result>>>,
  Check<Agrees<Drift<"Epic", Web.Epic, Server.Epic>>>,
  Check<Agrees<Drift<"Milestone", Web.Milestone, Server.Milestone>>>,
  Check<Agrees<Drift<"Cycle", Web.Cycle, Server.Cycle>>>,
  Check<Agrees<Drift<"View", Web.View, Server.View>>>,
  Check<Agrees<Drift<"Watcher", Web.Watcher, Server.Watcher>>>,
  Check<Agrees<Drift<"Notification", Web.Notification, Server.Notification>>>,
  Check<Agrees<Drift<"TaskLink", Web.TaskLink, Server.TaskLink>>>,
  Check<Agrees<Drift<"Template", Web.Template, Server.Template>>>,
  Check<Agrees<Drift<"Preference", Web.Preference, Server.Preference>>>,
  Check<Agrees<Drift<"Resource", Agents.Resource, Server.Resource>>>,
  Check<Agrees<Drift<"ResourceClaim", Agents.Claim, Server.ResourceClaim>>>,
  Check<Agrees<Drift<"Webhook", Automation.Webhook, Server.Webhook>>>,
  Check<Agrees<Drift<"WebhookDelivery", Automation.Delivery, Server.WebhookDelivery>>>,
  Check<Agrees<Drift<"Rule", Automation.Rule, Server.Rule>>>,
  Check<Agrees<Drift<"RuleMatch", Automation.RuleMatch, Server.RuleMatch>>>,
  Check<Agrees<Drift<"RuleAction", Automation.RuleAction, Server.RuleAction>>>,
  Check<Agrees<Drift<"Integration", Automation.Integration, Server.Integration>>>,
  Check<Agrees<Drift<"Doc", Docs.Doc, Server.Doc>>>,
  Check<Agrees<Drift<"Block", Docs.BlockRow, Server.Block>>>,
  Check<Agrees<Drift<"DocVersion", Docs.DocVersion, Server.DocVersion>>>,
  Check<Agrees<Drift<"DBProperty", Docs.DBProperty, Server.DBProperty>>>,
  Check<Agrees<Drift<"DBView", Docs.DBView, Server.DBView>>>,
  Check<Agrees<Drift<"Ref", Docs.DocRef, Server.Ref>>>,
  Check<Agrees<Drift<"DocSource", Docs.DocSource, Server.DocSource>>>,
  Check<Agrees<Drift<"Presence", Docs.PresenceEntry, Server.Presence>>>,
];
