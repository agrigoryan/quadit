// The Trello source: the JSON a board exports.

package importer

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// trello reads the JSON that a Trello board exports.
type trello struct{}

// Kind is "trello".
func (trello) Kind() string { return "trello" }

// trelloBoard is the part of a board export that is brought over.
type trelloBoard struct {
	Lists []struct{ ID, Name string }
	Cards []struct {
		ID, Name, Desc, IDList, Due, ShortURL string
		Closed                                bool
		Labels                                []struct{ Name, Color string }
		IDChecklists                          []string
	}
	Checklists []struct {
		ID, Name   string
		CheckItems []struct{ Name, State string }
	}
	Actions []struct {
		Type, Date    string
		MemberCreator struct{ FullName string }
		Data          struct {
			Text string
			Card struct{ ID string }
		}
	}
}

// Read reads the board's JSON export at path.
func (trello) Read(path string, _ Options) (Plan, error) {
	plan := Plan{Source: "trello"}
	raw, err := os.ReadFile(path)
	if err != nil {
		return plan, err
	}
	var board trelloBoard
	if err := json.Unmarshal(raw, &board); err != nil {
		return plan, fmt.Errorf("%s is not a Trello board export: %w", path, err)
	}
	listName := map[string]string{}
	for _, l := range board.Lists {
		listName[l.ID] = l.Name
	}
	checks, comments := board.checklists(), board.comments()
	for _, c := range board.Cards {
		t := Task{Ext: c.ID, Title: c.Name, Description: c.Desc, Status: listName[c.IDList], DueOn: c.Due, URL: c.ShortURL, Comments: comments[c.ID]}
		t.Category = category(t.Status)
		for _, id := range c.IDChecklists {
			t.Description += checks[id]
		}
		for _, l := range c.Labels {
			t.Labels = append(t.Labels, orStr(l.Name, l.Color))
		}
		if c.Closed && t.Category != core.CatDone {
			t.Status, t.Category = "", core.CatCanceled // archived there
		}
		plan.Tasks = append(plan.Tasks, t)
	}
	return plan, nil
}

// checklists gives each checklist as Markdown, by its id: it goes under
// the description of the card that has it.
func (b trelloBoard) checklists() map[string]string {
	out := map[string]string{}
	for _, cl := range b.Checklists {
		var md strings.Builder
		fmt.Fprintf(&md, "\n\n**%s**\n\n", cl.Name)
		for _, it := range cl.CheckItems {
			mark := " "
			if it.State == "complete" {
				mark = "x"
			}
			fmt.Fprintf(&md, "- [%s] %s\n", mark, it.Name)
		}
		out[cl.ID] = md.String()
	}
	return out
}

// comments gives each card's comments, oldest first, by the card's id.
func (b trelloBoard) comments() map[string][]Comment {
	out := map[string][]Comment{}
	for _, a := range slices.Backward(b.Actions) { // the export lists newest first
		if a.Type == "commentCard" {
			out[a.Data.Card.ID] = append(out[a.Data.Card.ID], Comment{Author: a.MemberCreator.FullName, At: a.Date, Body: a.Data.Text})
		}
	}
	return out
}
