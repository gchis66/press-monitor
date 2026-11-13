# Press Release Monitor

**Live demo: https://press-monitor-ten.vercel.app**

Watches company newsrooms and emails an alert when a new press release appears. The subject line is the exact headline; the body is a four-sentence summary plus the link.

## The problem

The brief was 55 newsrooms checked every 20 minutes. Done the obvious way, that is 118,800 checks a month and a $749 monthly API bill. It also fails quietly: in a sample of 8 real corporate newsrooms, 3 couldn't be read with a plain HTTP fetch, and a monitor that can't see a page reports "no news" forever. So this repo is two things: a working pipeline, and the cost model that decides whether the production version is worth running.

## How it works

```
                    ┌─ TIER 1  RSS or Atom feed ............ free
  55 newsrooms ─────┼─ TIER 2  scrape and diff ............. 1 credit per check
                    └─ TIER 3  only on a real change:
                                 extract, read the article, write the email, send
```

**Tier 1 is the whole cost story.** Every site with a working feed is polled for free, which removes 2,192 credits a month from the bill. Twenty feeds is the difference between $399 and $99 a month.

**Scheduling uses Firecrawl's monitor, not my own cron.** It handles the interval, the diff and the webhook, so the code is one stateless webhook receiver with no cron infrastructure.

| Approach (55 sites, every 20 min) | Credits a month | Cost a month |
|---|---|---|
| Extract on every check | 602,800 | $749 |
| Scrape plus free change tracking | 122,100 | $399 |
| **Tiered (this repo)** | **77,700** | **$99** |

## Three gates, enforced in code, not by prompt

1. **Exactly four sentences.** Checked deterministically, retried once, then flagged honestly if it still fails. The sentence splitter handles the abbreviations press releases are full of (`Caterpillar Inc.`, `U.S.`, `4:30 p.m.`, `$4.2 million`, `Dr. Chen`), because a naive split on periods miscounts almost every real release.
2. **The headline must appear verbatim in the article, or the email is not sent.** Graded, not binary: `exact` ships, `composed` (a truncated listing headline) ships with a caution, `missing` is blocked. Grading matters because false alarms teach people to ignore the warning.
3. **The link goes to the release**, not back to the newsroom index.

## Measured (real API calls)

Plain HTTP fetching failed on 3 of 8 real newsrooms: two returned 403 (Tesla, Caterpillar) and one returned an empty JavaScript shell (J&J). Firecrawl cleared all 8 on default settings.

Full pipeline against the deployed URL, all gates green:

| Site | Latency | AI cost | Tier |
|---|---|---|---|
| Tesla IR | 3.3 s | $0.00061 | 2 |
| CrowdStrike IR | 8.6 s | $0.00174 | 1 (RSS) |
| Caterpillar | 7.0 s | $0.00121 | 2 |
| Delta News | 7.8 s | $0.00094 | 1 (RSS) |

Mean 6.7 s in production. **92 of 92 live assertions pass against the deployed URL.**

A soak test (5 sites, 12 rounds, 5-minute interval) produced **zero false positives across 44 checks on the four stable sites**, and caught a fifth site that fired on every check. That one is below.

## Bugs that only live testing caught

**A rotating CAPTCHA that never diffs clean.** One investor site intermittently serves a reCAPTCHA whose challenge text changes on every load ("motorcycles", "stairs", "crosswalks"...). The page can never match itself, so 11 of 11 checks reported a change. At a 20-minute interval that is 72 junk emails a day from one site, which is how a monitoring product gets switched off in its first week.

Every normal defense misses it. The page is longer than several real newsrooms, it returns HTTP 200, the diff tool's randomization filter doesn't cover rendered text, and an LLM asked for press releases on it either returns nothing or invents some. `lib/botwall.ts` matches 14 challenge patterns against the rendered page and counts single-use URLs to flag pages that can't be diffed. It deliberately never matches the bare word "captcha", because many real pages say "protected by reCAPTCHA" in the footer. Blocking those would silently drop real sites. Regression tests pin all 8 captured challenges as must-block, and privacy notices plus real releases as must-not-block.

**A fake "out of credit" error on every success.** The error check matched `credit|quota` against the whole response, and every successful response contains `"creditsUsed":5`. Unit tests passed; the live suite caught 4 of 4 working sites returning a 502. The check now reads only the `error` field and requires `success === false`.

**An unhandled 500 on thin pages.** A content check threw outside the try block. The live suite now asserts every error is under 500 and readable.

**Two traps designed around up front:**
- A mistyped hostname returns HTTP 200 with `success: false` and empty content. Read naively, a dead site looks like a site with no news, forever. `assertOk()` is the single choke point, and site health raises its own alert.
- A "feed" URL ending in `.xml` can return an HTML page. Trusting the extension would park the site in the free tier where it never detects anything. `looksLikeFeed()` checks the body instead.

## Run it

```bash
npm install
cp .env.example .env.local     # add FIRECRAWL_API_KEY and OPENROUTER_API_KEY
npm run dev                    # http://localhost:3000
```

```bash
npm test                                          # 76 logic assertions, no network
npm run test:live                                 # live suite against a running instance
BASE_URL=https://your-url.vercel.app npm run test:live
npm run test:soak                                 # false-positive soak (HOURS and INTERVAL_MIN env)
```

## Layout

| Path | Role |
|---|---|
| `lib/cost.ts` | Credit and plan math |
| `lib/discover.ts` | Feed detection and tier assignment |
| `lib/firecrawl.ts` | Scrape client that makes silent failure impossible |
| `lib/botwall.ts` | Bot wall and undiffable page detection |
| `lib/summarize.ts` | LLM calls with strict JSON schemas |
| `lib/verify.ts` | The three gates |
| `lib/pipeline.ts` | Orchestration |
| `app/page.tsx` | Inbox preview, gate results, evidence panel, cost calculator |
| `app/api/preview/route.ts` | The one endpoint, rate limited |

## Security

Keys stay server side and never reach the browser. `/api/preview` is limited to 20 previews an hour per IP. Nothing is stored; every request is processed in memory.
