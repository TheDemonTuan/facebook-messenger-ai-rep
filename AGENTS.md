# Agent Instructions

## Facebook Messenger DOM changes

Before changing any code that reads, classifies, filters, deduplicates, or enriches Messenger data, inspect the current rendered Messenger DOM for the affected flow. This includes message bubbles, sender identity, timestamps, receipts, media, thread routes, sidebar snippets, recipient search, and conversation state.

1. Use the existing authorized browser-agent session on the VPS when available. If access requires a restart, first check for active sends and obtain permission before interrupting observation.
2. Capture the relevant rendered DOM structure and compare it with the parser output. Never infer selectors, message boundaries, media ownership, sender identity, or Facebook route semantics from text alone.
3. Redact names, IDs, URLs, cookies, tokens, and message content before committing a fixture. Preserve the DOM structure and attributes required by the parser.
4. Add or update a regression fixture and parser/adapter test from the observed structure before modifying production logic.
5. If a current DOM capture is unavailable, stop before implementing selector-based behavior. State the blocker and request an authorized capture instead of guessing.
6. Run the focused parser/adapter tests and the full relevant test suite after the change. For Dashboard changes, run browser acceptance tests on desktop and mobile.

Do not use manually invented HTML as proof that a Messenger DOM change is correct. Fixtures are regression coverage only after they have been grounded in an observed, sanitized DOM capture.
