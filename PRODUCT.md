# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: Sev, the owner, signed in through the family sign-on with an `admin` identity. He is looking for a post he half remembers reading in his Bluesky feeds. He searches often from his phone as well as the desktop. A second audience is anyone who lands on the public `/demo` (for example from the public repo) and needs to understand what skyback is.

## Product Purpose

skyback archives what goes through Sev's Bluesky Following timeline, and any saved feeds he switches on, and makes it full text searchable, so a post he read and half remembers can be found again. Bluesky's own search covers only posts by author or across the whole network, and the timeline is not in the account data export. Success is finding the half-remembered post quickly.

## Positioning

It searches your own timeline, which neither Bluesky search nor the data export can do. Archiving happens live as posts pass through, so what is searchable is what you actually saw.

## Operating Context

Daily cron catch-up, plus catch-up when the page is opened; "Search further back" goes older on demand; Sync now, Fetch now and Reload my saved feeds are manual controls. A status line at the top tells him what is captured. Runs on Cloudflare's free plan, so small runs and strict D1 budgets shape what the UI can do.

## Capabilities and Constraints

- Full text search over archived posts: text, alt text, link cards, quotes.
- Feeds selector for Following plus saved feeds, each on or off.
- Only an `admin` identity gets in; the public `/demo` shows sample posts (The Onion's public feed), searched in the browser, and never touches D1 or owner controls.
- Page content is untrusted: built with `textContent`, highlights as `<mark>` nodes, no `innerHTML` for post content.
- Plain JavaScript, no framework; page is `src/worker/ui/page.html` with `app.client.js`.

## Brand Commitments

The name is skyback. It is a personal tool of Sev's, shown publicly only through the demo. No em dashes in copy; minimal hyphens.

## Evidence on Hand

`docs/screenshot.png`, demo sample posts in `src/worker/ui/demo-data.json` (public posts from a public account). No testimonials, users or metrics exist and none should be invented.

## Product Principles

1. Private and mine: nothing of the owner's is exposed, and owner controls stay clearly separate from the public demo.
2. Get to the half-remembered post fast; forgiving queries beat power syntax.
3. Be honest about what is and is not captured; the status line never overstates coverage.
4. Phone use is first class, not an afterthought.
5. The demo explains the app to strangers without implying it is a service they can sign up for.

## Accessibility & Inclusion

No product-specific standard beyond sound defaults. Phone use is binding.
