package core

import (
	"slices"
	"testing"
)

func TestAScaleHasItsValuesTheExtendedOnesAndZeroWhereAllowed(t *testing.T) {
	for _, c := range []struct {
		name     string
		settings *ProjectSettings
		want     []int
	}{
		{"fibonacci", &ProjectSettings{Estimates: true, EstimateScale: ScaleFibonacci}, []int{1, 2, 3, 5, 8}},
		{"fibonacci extended", &ProjectSettings{Estimates: true, EstimateScale: ScaleFibonacci, EstimateExtended: true}, []int{1, 2, 3, 5, 8, 13, 21}},
		{"exponential", &ProjectSettings{Estimates: true, EstimateScale: ScaleExponential}, []int{1, 2, 4, 8, 16}},
		{"exponential extended", &ProjectSettings{Estimates: true, EstimateScale: ScaleExponential, EstimateExtended: true}, []int{1, 2, 4, 8, 16, 32, 64}},
		{"linear with zero", &ProjectSettings{Estimates: true, EstimateScale: ScaleLinear, EstimateZero: true}, []int{0, 1, 2, 3, 4, 5}},
		{"linear extended", &ProjectSettings{Estimates: true, EstimateScale: ScaleLinear, EstimateExtended: true}, []int{1, 2, 3, 4, 5, 6, 7}},
		{"t-shirt, as numbers", &ProjectSettings{Estimates: true, EstimateScale: ScaleTShirt, EstimateExtended: true}, []int{1, 2, 3, 5, 8, 13, 21}},
		{"points takes any number", &ProjectSettings{Estimates: true, EstimateScale: ScalePoints}, nil},
		{"no scale named is points", &ProjectSettings{Estimates: true}, nil},
		{"a scale while estimates are off holds nothing", &ProjectSettings{EstimateScale: ScaleFibonacci}, nil},
		{"no settings", nil, nil},
	} {
		if got := c.settings.EstimateValues(); !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestAScaleIsSaidInTheProjectsWords(t *testing.T) {
	for _, c := range []struct {
		settings *ProjectSettings
		want     string
	}{
		{&ProjectSettings{Estimates: true, EstimateScale: ScaleFibonacci}, "1, 2, 3, 5 or 8 points"},
		{&ProjectSettings{Estimates: true, EstimateScale: ScaleTShirt}, "XS, S, M, L or XL"},
		{&ProjectSettings{Estimates: true, EstimateScale: ScaleTShirt, EstimateExtended: true, EstimateZero: true}, "0, XS, S, M, L, XL, XXL or XXXL"},
		{&ProjectSettings{Estimates: true, EstimateScale: ScalePoints}, "any whole number of points"},
		{nil, "any whole number of points"},
	} {
		if got := c.settings.EstimateWords(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.settings, got, c.want)
		}
	}
}

func TestATShirtProjectNamesAnEstimateBySizeAndAnyOtherByNumber(t *testing.T) {
	tshirt := &ProjectSettings{Estimates: true, EstimateScale: ScaleTShirt}
	for _, c := range []struct {
		settings *ProjectSettings
		n        int
		want     string
	}{
		{tshirt, 3, "M"},
		{tshirt, 21, "XXXL"},
		{tshirt, 4, "4"}, // off the scale: its number
		{tshirt, 0, "0"},
		{&ProjectSettings{Estimates: true, EstimateScale: ScaleFibonacci}, 3, "3"},
		{&ProjectSettings{EstimateScale: ScaleTShirt}, 3, "3"}, // estimates off: no sizes
	} {
		if got := c.settings.EstimateName(c.n); got != c.want {
			t.Errorf("%+v, %d: %q, want %q", c.settings, c.n, got, c.want)
		}
	}
}

func TestAnEstimateIsReadAsANumberOrATShirtSizeOfAnyCase(t *testing.T) {
	for word, want := range map[string]int{"XS": 1, "s": 2, " m ": 3, "L": 5, "xl": 8, "XXL": 13, "xxxl": 21, "0": 0, "4": 4, "40": 40} {
		if got, ok := EstimatePoints(word); !ok || got != want {
			t.Errorf("%q: %d %v, want %d", word, got, ok, want)
		}
	}
	for _, notAnEstimate := range []string{"", "XXXXL", "-1", "2.5", "medium"} {
		if got, ok := EstimatePoints(notAnEstimate); ok {
			t.Errorf("%q was read as %d", notAnEstimate, got)
		}
	}
}

func TestATaskCountsItsEstimateOrOnePoint(t *testing.T) {
	zero, five := 0, 5
	on := &ProjectSettings{Estimates: true, EstimateScale: ScaleFibonacci}
	ignoring := &ProjectSettings{Estimates: true, EstimateScale: ScaleFibonacci, EstimateIgnoreUnestimated: true}
	for _, c := range []struct {
		name     string
		settings *ProjectSettings
		estimate *int
		want     int
	}{
		{"estimates off, with an estimate", &ProjectSettings{}, &five, 1},
		{"no settings", nil, nil, 1},
		{"its estimate", on, &five, 5},
		{"an estimate of zero", on, &zero, 0},
		{"no estimate", on, nil, 1},
		{"no estimate, where those count nothing", ignoring, nil, 0},
		{"an estimate, where those without count nothing", ignoring, &five, 5},
	} {
		if got := c.settings.Points(Task{Estimate: c.estimate}); got != c.want {
			t.Errorf("%s: %d points, want %d", c.name, got, c.want)
		}
	}
}
