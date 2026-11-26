// Estimates: the scales a project estimates its tasks on, how it names an
// estimate, and how many points a task counts for.

package core

import (
	"slices"
	"strconv"
	"strings"
)

// The scales a project may estimate on (ProjectSettings.EstimateScale).
const (
	ScaleFibonacci   = "fibonacci"
	ScaleExponential = "exponential"
	ScaleLinear      = "linear"
	ScaleTShirt      = "tshirt"
	// ScalePoints takes any whole number, 0 or more: what a project had
	// before scales, and what one that names no scale still has.
	ScalePoints = "points"
)

// EstimateScales are the scales' names, in the order they are offered.
var EstimateScales = []string{ScaleFibonacci, ScaleExponential, ScaleLinear, ScaleTShirt, ScalePoints}

// scaleValues are each scale's values in points, smallest first: the first
// scaleLength of them, then the two the extended scale adds. The T-shirt
// sizes stand for the Fibonacci values.
var scaleValues = map[string][]int{
	ScaleFibonacci:   {1, 2, 3, 5, 8, 13, 21},
	ScaleExponential: {1, 2, 4, 8, 16, 32, 64},
	ScaleLinear:      {1, 2, 3, 4, 5, 6, 7},
	ScaleTShirt:      {1, 2, 3, 5, 8, 13, 21},
}

// scaleLength is how many values a scale has when it is not extended.
const scaleLength = 5

// TShirtSizes are the T-shirt scale's sizes, smallest first, each standing
// for the value in the same place of the scale (XS 1, S 2, M 3 … XXXL 21).
var TShirtSizes = []string{"XS", "S", "M", "L", "XL", "XXL", "XXXL"}

// EstimatePoints reads an estimate written as a word: a whole number of
// points, 0 or more, or a T-shirt size, read without regard to case, which
// stands for its number of points on every project. ok is false for
// anything else.
func EstimatePoints(word string) (points int, ok bool) {
	word = strings.TrimSpace(word)
	if n, err := strconv.Atoi(word); err == nil {
		return n, n >= 0
	}
	i := slices.IndexFunc(TShirtSizes, func(size string) bool { return strings.EqualFold(size, word) })
	if i < 0 {
		return 0, false
	}
	return scaleValues[ScaleTShirt][i], true
}

// The methods below read a project's settings as they stand: a nil
// *ProjectSettings is a project with every switch off. A project that does
// not estimate holds its tasks' estimates to no scale and names them by
// number, whatever scale it keeps for when it estimates again.

// Estimating reports whether the project estimates its tasks.
func (s *ProjectSettings) Estimating() bool { return s != nil && s.Estimates }

// scale is the scale estimates are held to and named on: the project's
// own while it estimates, points otherwise or when it names none.
func (s *ProjectSettings) scale() string {
	if !s.Estimating() || s.EstimateScale == "" {
		return ScalePoints
	}
	return s.EstimateScale
}

// ZeroEstimates reports whether 0 is an estimate of its own on the
// project, apart from none. Where it is not, a 0 sent clears the estimate.
func (s *ProjectSettings) ZeroEstimates() bool { return s.Estimating() && s.EstimateZero }

// EstimateValues are the estimates the project's scale allows, in points,
// smallest first: 0 first where zero estimates are allowed, then the
// scale's values, with the extended ones when it is extended. It is nil on
// points (and where the project does not estimate), which take any whole
// number.
func (s *ProjectSettings) EstimateValues() []int {
	values, ok := scaleValues[s.scale()]
	if !ok {
		return nil
	}
	if !s.EstimateExtended {
		values = values[:scaleLength]
	}
	if s.ZeroEstimates() {
		return append([]int{0}, values...)
	}
	return slices.Clone(values)
}

// EstimateName is an estimate as the project says it: the size on the
// T-shirt scale ("M"), the number on any other ("3"). A value off the
// T-shirt scale, 0 among them, is said by its number.
func (s *ProjectSettings) EstimateName(points int) string {
	if s.scale() == ScaleTShirt {
		if i := slices.Index(scaleValues[ScaleTShirt], points); i >= 0 {
			return TShirtSizes[i]
		}
	}
	return strconv.Itoa(points)
}

// EstimateWords says the estimates the project takes, for a sentence:
// "1, 2, 3, 5 or 8 points", "XS, S, M, L or XL", or on points "any whole
// number of points".
func (s *ProjectSettings) EstimateWords() string {
	values := s.EstimateValues()
	if values == nil {
		return "any whole number of points"
	}
	names := make([]string, len(values))
	for i, n := range values {
		names[i] = s.EstimateName(n)
	}
	words := strings.Join(names[:len(names)-1], ", ") + " or " + names[len(names)-1]
	if s.scale() == ScaleTShirt {
		return words
	}
	return words + " points"
}

// Points is how many points a task of the project counts for wherever
// points are added up (a cycle's, an epic's): 1 where the project does not
// estimate; the task's estimate, 0 included, where it has one; else 1, or
// 0 where the project counts a task without an estimate as nothing.
func (s *ProjectSettings) Points(t Task) int {
	switch {
	case !s.Estimating():
		return 1
	case t.Estimate != nil:
		return *t.Estimate
	case s.EstimateIgnoreUnestimated:
		return 0
	}
	return 1
}
