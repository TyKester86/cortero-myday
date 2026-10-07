# Hana's medical reference on ADHD

corpus_last_reviewed: 2026-10-06
next_review_due: 2027-01-06

A curated, structured reference Hana reads (after the *Conquer ADHD Everyday* chapters) before she answers questions about ADHD. It is not medical advice and not a substitute for a clinician.

## What goes in

Only authoritative, current sources:

- CDC (cdc.gov/adhd) and NIMH (nimh.nih.gov)
- The American Academy of Pediatrics clinical practice guideline (Pediatrics, 2019)
- NICE guideline NG87 (UK)
- Peer-reviewed literature: systematic reviews, meta-analyses, Cochrane reviews and consensus statements, found and checked on PubMed

No blogs, no social media, no unsourced claims. Every entry carries a topic, a plain-language summary, the source with its publication or last-updated date, and the source's URL. Where the evidence is weak, small, mixed or missing, the entry says so.

## File format

Each topic file holds entries like this (Hana's loader reads these fields):

```
### Entry title
summary: one plain-language paragraph
source: Organization or authors — title (date)
url: https://…
```

## Refreshing it (quarterly)

Every three months (next: 2027-01-06):

1. Re-open each source URL. Note any new "last updated" date and re-read the page for changed recommendations.
2. Check for a newer edition or update of each guideline: AAP ADHD guideline, NICE NG87 (and any NICE surveillance decision), DSM text revisions.
3. Search PubMed for new Cochrane reviews and large meta-analyses on ADHD medication, diet, omega-3, exercise, sleep, and ADHD in women; replace an entry only when a newer, stronger review supersedes it.
4. Update the summaries and dates, then `corpus_last_reviewed` and `next_review_due` above.
5. Run the e2e suite (it checks the library loads and every entry has a source, a date and a URL).

Last review: 2026-10-06. CDC pages were checked on that date (CDC last updated them June–July 2026), NIMH was revised August 2026, NICE NG87 was last updated 13 September 2019, and the AAP guideline was published October 2019.
