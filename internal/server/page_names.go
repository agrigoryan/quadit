// Pages named in text an agent reads, said with their titles as they are now.

package server

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

const uuidForm = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

// pageRefRE finds what in text may point at a page, whole, so that nothing
// is ever written inside it: a Markdown link (group 1 its words, escaped as
// Markdown escapes them; group 2 its address), an autolink (group 3), a
// bare address (group 4), a bare doc:ID (group 5, the id). Which of them
// point at a page is pageAddressRE's to say of their address.
var pageRefRE = regexp.MustCompile(`\[((?:\\.|[^\[\]\\\n])*)\]\(([^()\s]*)(?:\s+"[^"\n]*")?\)` +
	`|<([^<>\s]+)>` +
	`|(https?://[^\s<>()]*[^\s<>().,;:!?'"])` +
	`|\bdoc:(` + uuidForm + `)`)

// pageAddressRE is an address that points at a page, as the server records
// it (internal/engine/notify.go): doc:ID, or one with /docs/ID in its path.
var pageAddressRE = regexp.MustCompile(`^doc:(` + uuidForm + `)$|/docs?/(` + uuidForm + `)(?:[/?#]|$)`)

// markdownEscape is a backslash before a character Markdown would read.
var markdownEscape = regexp.MustCompile(`\\(.)`)

// pageRef is what a match of pageRefRE points at: a page's id ("" for
// none), and, for a link, the words it reads.
func pageRef(m []string) (docID, words string, link bool) {
	address := m[2] + m[3] + m[4]
	if m[5] != "" {
		return m[5], "", false
	}
	if a := pageAddressRE.FindStringSubmatch(address); a != nil {
		return a[1] + a[2], markdownEscape.ReplaceAllString(m[1], "$1"), m[2] != ""
	}
	return "", "", false
}

// pageTitles are what a reader may call pages, by id: the title of a page
// it may see, or "" for one it may not, one in the trash and one that is
// not there, which are left as written.
type pageTitles map[string]string

// readTitles adds the titles of the pages the texts point at by id that
// titles does not have yet, read at once. A read that fails is logged, and
// the pages are left as written: naming them is a help, not the answer.
func (who *viewer) readTitles(ctx context.Context, titles pageTitles, texts ...string) {
	var ids []string
	for _, text := range texts {
		for _, m := range pageRefRE.FindAllStringSubmatch(text, -1) {
			if docID, _, _ := pageRef(m); docID != "" {
				if _, known := titles[docID]; !known {
					titles[docID] = ""
					ids = append(ids, docID)
				}
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	var docs []core.Doc
	if err := who.db.List(ctx, &docs, store.Where(store.In("id", ids), store.Live)); err != nil {
		who.log.Warn("text left the pages it names untitled: they could not be read", "err", err)
		return
	}
	for _, doc := range docs {
		if who.canSeeDoc(doc) {
			titles[doc.ID] = oneLine(doc.Title, 0)
		}
	}
}

// named is text with each page it points at by id followed by the page's
// title: doc:ID becomes doc:ID ("Title"), after the whole of a link or an
// address. A link whose words are the title already is left as written, as
// is [[Title]], which names the page by its title, and a page titles leaves
// untitled. It is for text an agent reads, never for text it may write back.
func (titles pageTitles) named(text string) string {
	return pageRefRE.ReplaceAllStringFunc(text, func(ref string) string {
		docID, words, link := pageRef(pageRefRE.FindStringSubmatch(ref))
		now := titles[docID]
		if now == "" || (link && strings.TrimSpace(words) == now) {
			return ref
		}
		return ref + " (" + strconv.Quote(now) + ")"
	})
}

// namePages is text named (pageTitles.named) with the titles read for it.
func (who *viewer) namePages(ctx context.Context, text string) string {
	titles := pageTitles{}
	who.readTitles(ctx, titles, text)
	return titles.named(text)
}
