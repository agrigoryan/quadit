package server

import (
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/md"
)

// A file that opens with a level-1 heading (after front matter, if any) is
// called by that heading: its page takes the heading as its title, and the
// heading is not repeated at the top of the page's text. Written back, the
// page's title is put in front again as that heading, so a file that went
// through a page comes back as it was.
//
// Whether a page is called by its file's heading is read from both sides
// each time: the file opens with a heading, and the page's text does not.
// A page synced before titles were taken from headings still has the
// heading in its text, so it is left as it was until its file changes.

var titleRE = regexp.MustCompile(`^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$`)

// frontMatter splits off the block between a first line "---" and the next
// line "---", with the newline after it.
func frontMatter(text string) (fm, rest string) {
	if !strings.HasPrefix(text, "---\n") {
		return "", text
	}
	end := strings.Index(text[4:], "\n---\n")
	if end < 0 {
		return "", text
	}
	cut := 4 + end + len("\n---\n")
	return text[:cut], text[cut:]
}

// keepFrontMatter is text, to be written to file, with the front matter
// file has, byte for byte and with the blank lines after it, when the page's
// says the same. A page holds front matter as Markdown blocks, which spell
// it their own way (blank lines, list indents), so the two are compared as
// those blocks render; a page whose front matter was edited writes its own.
func keepFrontMatter(file, text string) string {
	fileFM, fileRest := frontMatter(file)
	pageFM, pageRest := frontMatter(text)
	if fileFM == "" || pageFM == "" || md.Render(md.Parse(fileFM)) != md.Render(md.Parse(pageFM)) {
		return text
	}
	gap := fileRest[:len(fileRest)-len(strings.TrimLeft(fileRest, "\n"))]
	return fileFM + gap + strings.TrimLeft(pageRest, "\n")
}

// openingHeading is the text of the level-1 heading a file or a page opens
// with, after front matter and blank lines, and the text without that line.
func openingHeading(text string) (title, rest string, ok bool) {
	fm, body := frontMatter(text)
	body = strings.TrimLeft(body, "\n")
	line, after, _ := strings.Cut(body, "\n")
	m := titleRE.FindStringSubmatch(strings.TrimRight(line, "\r"))
	if m == nil {
		return "", text, false
	}
	after = strings.TrimLeft(after, "\r\n")
	if fm != "" && after != "" {
		after = "\n" + after
	}
	return strings.TrimSpace(m[1]), fm + after, true
}

// titleOfFile is the title a file's page takes from its opening heading,
// and the page's text without it. A file whose heading is followed by
// another level-1 heading keeps both in its text.
func titleOfFile(text string) (title, rest string, ok bool) {
	title, rest, ok = openingHeading(text)
	if !ok {
		return "", text, false
	}
	if _, _, twice := openingHeading(rest); twice {
		return "", text, false
	}
	return title, rest, true
}

// headed reports whether a page is called by its file's heading: the file
// opens with one, and the page's text does not.
func headed(file, body string) bool {
	if _, _, ok := titleOfFile(file); !ok {
		return false
	}
	_, _, bodyHas := openingHeading(body)
	return !bodyHas
}

// withHeading is a page's text with its title in front as a level-1
// heading, after front matter, as its file has it.
func withHeading(title, body string) string {
	fm, rest := frontMatter(body)
	head := "# " + strings.ReplaceAll(title, "\n", " ") + "\n"
	rest = strings.TrimLeft(rest, "\n")
	if fm != "" {
		head = "\n" + head
	}
	if rest == "" {
		return fm + head
	}
	return fm + head + "\n" + rest
}

// pageSide is what a page says as its file would say it: its text, with
// its title in front when it is called by its file's heading.
func pageSide(title, file, body string) string {
	if headed(file, body) {
		return withHeading(title, body)
	}
	return body
}
