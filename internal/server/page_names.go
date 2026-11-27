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

// pageRefRE finds the references to a page by id that text makes, as the
// server records them (internal/engine/notify.go): a Markdown link to
// doc:ID or to a page's address ([words](doc:ID)), else a bare doc:ID or
// address. Its groups are the link's words and the id it names, or the id
// of a bare reference.
var pageRefRE = regexp.MustCompile(`\[([^\[\]\n]*)\]\((?:doc:|[^\s()]*/docs?/)(` + uuidForm + `)\)` +
	`|(?:doc:|https?://[^\s()<>]*/docs?/)(` + uuidForm + `)`)

const uuidForm = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

// namePages is text with each page it points at by id followed by the
// page's title as it is now: doc:ID becomes doc:ID ("Title"). A link whose
// words are the title already is left as written, as is [[Title]], which
// names the page by its title. A page the reader may not see, one in the
// trash and one that is not there stay as written. It is for text an agent
// reads, never for text it may write back.
func (who *viewer) namePages(ctx context.Context, text string) string {
	titles := map[string]string{} // by page id; "" for one not to name
	title := func(docID string) string {
		if got, asked := titles[docID]; asked {
			return got
		}
		var doc core.Doc
		if who.foundForLine(ctx, &doc, store.Eq("id", docID), store.Live) && who.canSeeDoc(doc) {
			titles[docID] = doc.Title
		}
		return titles[docID]
	}
	return pageRefRE.ReplaceAllStringFunc(text, func(ref string) string {
		m := pageRefRE.FindStringSubmatch(ref)
		words, docID := m[1], m[2]
		if docID == "" {
			docID = m[3]
		}
		now := title(docID)
		if now == "" || (m[2] != "" && strings.TrimSpace(words) == now) {
			return ref
		}
		return ref + " (" + strconv.Quote(now) + ")"
	})
}
