// Package importer brings work in from other tools. Each source is read
// into the same plain plan (tasks, comments, pages, files), and Apply turns
// a plan into changes. Imports go through the API like any other client,
// and can be run again: the same source item always becomes the same task
// or page, so a second run adds nothing twice.
//
// How the package is laid out:
//
//	plan.go      what every source is read into
//	source.go    the Source interface and the list of sources
//	<kind>.go    one source each: linear, asana, trello, github, folder
//	             (markdown, obsidian), notion, orbit
//	csv.go, fetch.go, zip.go, text.go   what several sources share
//	sink.go      where an import writes, and what it reports
//	apply*.go    making a plan: projects and workflow, tasks, files, pages
package importer

import "os"

// Plan is everything one import will make.
type Plan struct {
	Source   string // linear, trello, …
	Projects []Project
	Statuses []Status
	Labels   []Label
	Tasks    []Task
	Docs     []Doc
	Tables   []Table
	Files    []File
	// Notes say what the source could not give, for the one running the import.
	Notes []string
	// Tmp is a folder of copies made while reading; Close removes it.
	Tmp string
}

// Close removes what reading the source left on this machine.
func (p Plan) Close() {
	if p.Tmp != "" {
		os.RemoveAll(p.Tmp)
	}
}

// Project is a project to make if it is not there.
type Project struct {
	Key, Name string
}

// Status is a status of a project's workflow there, and Label a label:
// they come over whether or not a task uses them, in the order they had.
type Status struct {
	Project, Name, Category, Color string
}

type Label struct {
	Project, Name, Color string
}

// Task is one task as it comes from another tool.
type Task struct {
	// Number is the task's number where it lived; it keeps it here when
	// that number is free.
	Number      int
	Ext         string // its id there
	Project     string // key of the project it goes in; empty = the one asked for
	Title       string
	Description string
	Status      string // the status's name there
	Category    string // backlog, unstarted, started, waiting, done or canceled
	Priority    int    // 0 none, 1 urgent … 4 low
	Assignee    string // a name or an email address
	Labels      []string
	DueOn       string
	Estimate    int
	Epic        string
	ParentExt   string
	URL         string // where it lived
	Comments    []Comment
	// WasKey is what the task was called where it lived (ENG-12), kept in its
	// text so that old links and habits still find it.
	WasKey string
	// Blocks and Relates name other tasks of the same import by their Ext.
	Blocks  []string
	Relates []string
	// Files names the plan's files that were attached to the task there.
	Files []string
}

type Comment struct {
	Author string
	At     string
	Body   string
	Files  []string // the plan's files attached to the comment there
}

// Doc is one page.
type Doc struct {
	Ext       string
	ParentExt string
	Title     string
	Markdown  string
	Dir       string // where its relative images are, for Markdown folders
}

// Table is a database: columns and rows of text.
type Table struct {
	Ext       string
	ParentExt string
	Title     string
	Columns   []string
	Rows      [][]string // the first cell is the row's title
}

// File is a file that lived at the source: a copy of it on this machine,
// and the addresses that text there used for it.
type File struct {
	Ext   string   // its id there
	Path  string   // where the copy is
	Links []string // how descriptions, comments and pages there point at it
}
