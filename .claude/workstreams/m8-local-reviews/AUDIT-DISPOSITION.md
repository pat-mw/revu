# M8 landing audit — disposition of every finding

Every id raised by the 2026-09-02 landing audit (`AUDIT-2026-09-02.md` / `.json`), and where it went. 146 ids:
99 gaps + 47 weak-status items. A ticket id means a unit closes it; `COVERED` means another gap's unit closes
the same defect; `ACCEPTED` means the record already carries a ruling or a recorded deviation that makes it
not-a-defect (the reason is given — challenge any of these); `REFUTED` means three-lens verification killed it.

**Nothing here is a follow-up list.** M8.17 cannot close while any M8.13–M8.16 unit is open, so every row
below is either closed by a unit, closed by another row's unit, or has a written reason for standing.


## M8.13 — behaviour fixes (11)

| audit id | unit | reason |
| --- | --- | --- |
| `D5-g4` | Warn on a failed pin from syncLocalPull | A failed pin lands only in LocalSyncOutcome.pin and is rendered nowhere (M8.8 OQ3); the verified closer for D8A-g6 is a console.warn in syncLocalPull with a direct-api.test.ts pair — the smallest surface, no decision needed. Same unit as D8A-g6. |
| `D7-g1` | Order the inbox local section by open rows, not row presence | Verified 3/3: buildInboxSections orders on local.length > 0 over visibleRows, and showsInInbox keeps archived rows (OQ4), so an all-archived section renders first against the guide, R1 and the docstring. Order on an open local row with a closed-local-item test. |
| `D8A-g1` | Serve the local list row from live ref tips so staleness and the base-advanced seal fire | Major, verified 3/3: revud's localPullListItem serves compareKey/head.sha from the stored row, stamped by the same sync that stored the snapshot, so useStaleness is structurally false for a local review. The mock's listLocalPullRows docstring specifies 'ref tips as they are NOW', so revud is the divergent transport and conforming needs no ruling: read live tips per list poll and pin with a no-sync leg in local-resync.test.ts plus a mock tip-movement hook for the shared leg. |
| `D8A-g4` | Serve the local list row from live ref tips so staleness and the base-advanced seal fire | The base-advanced tooltip is portal-rendered and unpinned, and unreachable on a local review until D8A-g1 lands; its pin rides the live-row unit's tests (every code change lands with its tests), per the task's placement. |
| `D8A-g5` | Make re-sync rebuild over an unreadable snapshot or immutables row | 'Re-sync to rebuild' is a promise that cannot be kept for a corrupt immutables row or snapshot envelope because the re-sync reads the corrupt row first (M8.8 OQ8). Assert-the-advice-works: make performSync treat an unreadable row as absent and rebuild it — a behaviour fix; the only open question is ownership of store.ts, not a design choice. |
| `D8A-g6` | Warn on a failed pin from syncLocalPull | Verified 3/3: performSync reports pin: { ok: false } and nothing renders or logs it; closer is a console.warn in syncLocalPull naming the review and reason with a fires/silent test pair, striking OQ3 with that answer. |
| `D9-g1` | Order the inbox local section by open rows, not row presence | Same defect as D7-g1 from §9: an archived-only local section renders at the top; the 'below' test passes zero local rows. State-aware ordering plus a closed-local-item test. |
| `EC2-g3` | Count commits-since by SHA in files.tsx and queue.tsx | Verified 3/3: files.tsx commitsSince (and queue.tsx countCommitsSince) still use the author-date filter M8.8.3 removed and report 0 on a rebased branch; count by SHA after the thread's original_commit_id, whole range when absent, and retitle the local-sync.test.ts:3176 comment. |
| `M8.6-g2` | Refetch the branch listing every time the create dialog opens | Verified (3/3): the shell-mounted dialog never remounts, so useBranches refetches on reopen only past the 10 s staleTime; staleTime: 0 or an invalidate on open, corrected docstrings, and a QueryObserver test — behaviour fix, no decision. |
| `M8.8-g2` | Refuse all four write verbs and render read-only after a vanished branch | Major, verified 3/3: read-only after a deleted/renamed branch is incidental (only submit/reply pass through resolveLocalHead; no test drives any verb after git branch -D; no app surface renders the state). Route resolve/react through the head guard, pin all four verbs, and derive a read-only state in the app. |
| `M8.8-g4` | Serve the local list row from live ref tips so staleness and the base-advanced seal fire | The base-advanced banner cannot fire for a local review in direct mode because localCompareKey reads the stored row; the mock's listLocalPullRows docstring specifies live ref tips, so revud is the divergent transport. Same root cause and unit as D8A-g1. |

## M8.14 — proof debt (41)

| audit id | unit | reason |
| --- | --- | --- |
| `D4-g2` | Assert mutable.checks is [] on a local snapshot on every transport | mutable.checks is set to [] on both transports but read by no test on a local snapshot; one assertion in local-surface.test.ts and the shared local suite closes it (task: 'checks: []'). |
| `D6-g3` | Pin that the local write path cannot raise conflict | 'conflict is unreachable locally' is structural by inspection with no guard; a source scan of local-writes.ts and the local branches of local-surface.ts for the code, with writes.ts:410 as the positive control, pins it. |
| `D7-g3` | Pin the palette Go entry and the g l chord where a harness allows | The palette Go entry and the shell-side g l binding have no test; same doorway pins as M8.6-g4 (e2e drives them). |
| `D8A-g7` | Sync a remote-tracking base to a successful snapshot with real git | Two halves: no real-git leg syncs a refs/remotes base to a successful snapshot (§8.3) — a test; and no mock fixture is dirty (§8.16), which is D9-g3's M8.15 unit. Assigned for the test half. |
| `D9-g2` | Assert a synced snapshot ignores an uncommitted edit | The dirty flag is pinned but no test asserts a synced snapshot's blob/patch ignores an uncommitted edit; one assertion on the existing 'genuinely dirty worktree' test's snapshot closes it. |
| `D9-g4` | Pin archived-pair re-create on three transports | The guide's one-way-door claim (re-creating an archived pair returns the archived review) is true by construction on both transports but no test calls createLocalReview on an archived pair; add it to conformance/local-archive.ts so all three legs pin it. |
| `EC1-g1` | Replace the decorative requests===0 with a real count or drop it | requests===0 compares a literal to the hardcoded requests: 0 in local-surface.ts:800 and cannot go red; a guard comparing two quantities that move together asserts nothing. Drop it or make the field a real count — the task assigns it to proof debt. |
| `EC1-g2` | Add a positive control that the serve suite's fetch tripwire loaded | Nothing in local-reviews-serve.test.ts proves the --preload landed in the child; leg G and the e2e both have such a control. Same unit as M8.5-g2. |
| `EC2-g1` | Walk new-commit → re-sync → reconcile with a draft on a local review | Major, verified 3/3: no local-review walk does sync → draft → new head commit → re-sync → reconcileDraft; one describe in local-resync.test.ts reusing seed()/advanceHead() with newCommits pinned to exactly the one new SHA closes it. |
| `EC2-g2` | Rewrite the fixture with a real git rebase onto an advanced base | Every rebase is synthetic; the only real-git rewrite is an identical-tree amend so the pin-survival assertions cannot go red. A real `git rebase` onto an advanced base fixture is a test-only change. |
| `EC2-g4` | Add the real-mock reconcile parity leg for a head-absent draft | Same missing parity leg as M8.8-g1, seen from the criterion: the Check placed it in reconcile.test.ts and nothing imports createMockApi there. Closes with M8.8-g1's unit. |
| `EC2-g5` | Point the no-deletion source scan at local-surface.ts | The 'no deletion call' source scan reads local-sync.ts while performSync lives in local-surface.ts; the runtime tripwire holds the rule, the corroboration guards the wrong file. Test fix only. |
| `EC3-g1` | Graph-walk local-surface.ts in the write-isolation test | local-write-isolation.test.ts fences only the sink trio; local-surface.ts, whose methods the dispatcher calls, is name-scanned and imports ./blobs → ./github-client. Extend the graph walk with an allowlist for the sync-only path (task: 'local-surface graph walk in the isolation test'). |
| `EC3-g2` | Boot the real daemon with a GitHub half and drive the four local writes | The composition index.ts → createDirectApi with a wired GitHub half and a local review is exercised only by the scratch-repo Log claim; a boot-level test with a fake fetchImpl behind a real client through the four local writes closes it (task: 'a real boot with a GitHub half'). |
| `EC3-g3` | Pin the client's fetch path and wrap Bun.fetch in the guards | All three runtime guards wrap globalThis.fetch only and no static guard pins that github-client.ts keeps transmitting through it (opts.fetchImpl ?? fetch, no Bun.fetch in packages/revud/src). A source pin plus wrapping Bun.fetch in the guards is test/harness work with no product behaviour change; same unit as EC5-g3. |
| `EC4-g1` | Read audit_log/pr_author for a local id after a real local write | No test reads store.listAudit({pr: localId}) or getPrAuthor(localId) after a real local write; the store tripwire sweep proves it more strongly, so this is a redundancy read to add, no behaviour change. |
| `EC4-g2` | Run the collector and poll loop over a store holding local reviews | 'The collector's and poll loop's view of PR #N is unchanged' rests on an empty diff and upstream tripwires; no collector/poll-loop test runs over a store that holds local reviews (task: 'collector over a store holding local reviews'). |
| `EC4-g3` | Document and pin the sweep guard's three-table scope | PR_KEYED_TABLES arms only D4's three tables; drafts/viewed legitimately carry local ids on pr_number (M8.2.6), so the fix is to pin the scope — a docstring on the literal and a control that M8.2.4's invisibility assertions cover drafts.pr_number under a local id (task: 'the sweep guard scope'). |
| `EC5-g1` | Run the shared local suite over HTTP against a booted direct daemon | No leg runs the shared local suite through direct-router.ts over HTTP; the serve suite already boots a --local-only child daemon, so a leg H runner is feasible and the throwing-client objection does not apply under --local-only. The M8.11 rejection was a session choice, not an owner ruling, so it is proof debt rather than accepted. |
| `EC5-g2` | Run the diff-content branch of the local suite on legs E and F | Legs E/F declare compare:'empty' so the suite's diff-content assertions execute only on leg G; running the 'changes' branch over the seeded fixture review (or a mock dev hook attaching content) is fixture/test work with no product change. |
| `EC5-g3` | Pin the client's fetch path and wrap Bun.fetch in the guards | e2e/no-github-guard.ts wraps globalThis.fetch only; a future Bun.fetch call would not be recorded. Wrap Bun.fetch in the netlog guard, the preload and armFetchTripwire and pin the absence statically — same unit as EC3-g3. |
| `EC6-g2` | Pin RateChip's rateAvailable derivation | app-shell.tsx's rateAvailable derivation has no test; widening it to `true` shimmers the chip forever in a local-only workspace with every test green (task: 'rateAvailable derivation'). |
| `EC6-g3` | Pin the mode argument at the three presence-only gates | showSelfReviewLock, conversationSections and prPaletteCommands are wired by presence with the mode argument unread; chrome-sweep's handedAConstantMode scan already exists for the avatar sites and was not applied here (task: 'mode gates wired by presence'). |
| `M8.10-g2` | Add the direct delete runner as a conformance-matrix leg | conformance-local-delete.test.ts runs under the gate but is not a matrix leg, so the matrix summary M8.11 reads does not show the direct delete transport. Add the leg to scripts/conformance-matrix.ts. |
| `M8.11::verify-3` | Pin the matrix runner's exit 1 on a skipped required leg | Controls (b)–(e) have durable in-code halves; control (a) — the matrix runner exiting 1 naming a skipped required leg — has none (no test references scripts/conformance-matrix.ts). Add that pin. |
| `M8.12-g3` | Pin that the daemon's delete refusal names no id | retention.test.ts and the shared local-delete block assert only /discard/; direct-api.ts could regain the review id in the refusal sentence and the dialog would render it. One negative assertion with the mock's pin as the pattern. |
| `M8.12-g4` | Drive the delete dialog in the e2e | The header→dialog→confirm→navigate path is pinned by presence-only source scans and two manual walks; e2e/local-review.ts drives no delete. An e2e delete step is the durable closer. |
| `M8.3-g1` | Retarget the M8.3.1 rejection table at the production validator and drop dead normalizeRef | normalizeRef has no production caller; qualifyRef uses the shared isValidRefName/normalizeRefName — and so does the mock (local.ts:306-314), so the foreign-namespace pass-through is spec-consistent and needs no ruling. The debt is a rejection table guarding dead code: re-point it at the production validator, delete normalizeRef, and record the supersession in M8.3's ticket. |
| `M8.4-g2` | Drive useResolveThread/useAddReaction against the local sink | Sink answers and app optimistic fields are unit-tested on each side but no test drives useResolveThread/useAddReaction onMutate→onSuccess against the sink's returned value; a hook-level test closes it with no behaviour change. |
| `M8.5-g1` | Clear GH_TOKEN/GITHUB_TOKEN from the serve suite's child env | CLEARED_ENV_KEYS omits GH_TOKEN/GITHUB_TOKEN so 'no token' is a property of the code path, not the fixture; adding the two keys is a test-only change (task lists it explicitly). |
| `M8.5-g2` | Add a positive control that the serve suite's fetch tripwire loaded | The serve suite's --preload tripwire has no durable in-suite control that fetch was replaced in the child; same closer as EC1-g2 (a probe route that calls fetch and observes the named refusal). |
| `M8.6-g1` | Render RowBadges with dirty: true and assert the badge | RowBadges is never rendered with dirty: true; removing the badge or the dirtyReviews derivation leaves the suite green. One static-render assertion closes it. |
| `M8.6-g3` | Dispatch base_defaulted and pin the only-when-empty rule | create-local-review.test.ts never dispatches base_defaulted; the only-when-empty reducer rule is unpinned. Test only. |
| `M8.6-g4` | Pin the palette Go entry and the g l chord where a harness allows | The palette Go entry and the g l chord are walk-only; the e2e can drive both (it already drives the header button), which is the 'where a harness makes them possible' clause. |
| `M8.6-g5` | Drive the create dialog's key-swallowing in the e2e | The `{ enabled: !blocked }` wiring is pinned by reading source text; the browser leg was honestly recorded NOT RUN. An e2e step (open the dialog, press j, assert the inbox selection is unchanged) is the durable closer. |
| `M8.6-g6` | Rename the three-buckets test to what it asserts | 'still fill three buckets' asserts an exact two-bucket result; assertion correct, name wrong. Test-file rename only. |
| `M8.6::Verify-2` | Cold-load ?mock=1 in the e2e with the request recorder | The mock hard-reload with zero network requests is in-gate only by substitutes (testing exception 3); the e2e harness can cold-load ?mock=1 with its request recorder and assert zero API requests, a durable test with no behaviour change. |
| `M8.7-g2` | Pin dirty-before-author in the banner stack | chrome-sweep pins superseded before dirty but nothing pins dirty before author; one more ordering assertion, no behaviour change. |
| `M8.8-g1` | Add the real-mock reconcile parity leg for a head-absent draft | Major, verified 3/3: the real-mock parity leg (createMockApi imported into reconcile.test.ts, head-absent draft, identical newCommits) was never written and no matrix leg covers the head-absent branch. Tests only. |
| `M8.8-g5` | Add the @ts-expect-error row for DraftHead's paired fields | Only the runtime row exists; the Check's @ts-expect-error row for a headSha-without-compareKey call is absent, so compareKey becoming optional would pass unnoticed. Test only. |
| `M8.8::verify-5` | Pin the conflict-terminated apply's head move before submit | The conflict-terminated apply is corroborated by source order only because apply() is a hook closure; lift the head-move-before-submit sequence into a pinnable step or drive it through a QueryObserver — a test-harness change with no behaviour change. |

## M8.15 — owner rulings (14)

| audit id | unit | reason |
| --- | --- | --- |
| `D3-g4` | Rule OQ10: drafts on an archived review — writable or refused | M8.9 OQ10: the four write verbs refuse on an archived review but the gutter composer opens and a draft PUT answers 200, pinned as current behaviour by conformance/local-archive.ts. Owner decides writable-or-refused; both options written as alternative units, one struck. |
| `D7-g2` | Rule OQ10: drafts on an archived review — writable or refused | Guide §7's 'goes read-only' is ahead of the code until OQ10 is ruled; the guide sentence moves with the ruling. Same unit as D3-g4. |
| `D8B-g3` | Rule OQ10: drafts on an archived review — writable or refused | The unqualified 'read-only' in the guide and §8 #22 versus the draft-writable behaviour the conformance suite pins is OQ10; moves with the ruling. Same unit as D3-g4. |
| `D9-g3` | Give the mock a reachable dirty: true | Verified 3/3: the mock hard-codes dirty: false, so the spec never specifies D3's flag and the banner is invisible under ?mock=1; a fixture flag or mockDev toggle plus a conformance case is the owner's call per the task (same unit as M8.7-g1). |
| `D9-g6` | Rule OQ10: drafts on an archived review — writable or refused | OQ10 recorded and unruled; the conformance case that pins today's draft-writable behaviour moves whichever way the owner rules. Same unit as D3-g4. |
| `M8.10-g1` | Wire REVU_RECLAIM_BLOBS at boot or reword the runbook | Verified 3/3: the runbook promises an operator flag boot never exposes; wire REVU_RECLAIM_BLOBS at both createDirectApi call sites with a boot test, or reword the runbook — the owner picks. |
| `M8.11-g1` | Decide local-scenario.test.ts: collapse or keep, recorded | OQ3 ('decide before M8.11.1') was never decided: local-scenario.test.ts still sits beside the leg-E runner. Collapse into the shared suite or keep for its mock-armed tripwire — decided and recorded. |
| `M8.3-g2` | Rule on the live byte-level parity leg: write the runner or rule it out | OQ3 is open with no ruling and no smoke script; the owner decides whether a committed live byte-level parity runner is worth writing or the structural local-parity.test.ts leg is the whole answer. |
| `M8.3::OQ-5` | Rule on the copy status mapping (C → added) | C → 'added' was adopted as a proposal and nobody ruled; the copy status is unreachable without -C and the vocabulary is guarded. Record the ruling (keep or change) in M8.3's Rulings so no open question survives close-out. |
| `M8.5-g3` | Rule on bin/revu's local path: ship or keep deferring, on the board | The OQ6 ruling ('bin/revu gains no local path; the CLI is a follow-up') is recorded only in HANDOVER/LOG; at close-out the owner re-decides ship-or-keep-deferring and the outcome lands on BOARD.md's follow-ups either way — that board entry is what closes this gap. |
| `M8.6::R4` | Rule on renaming a mis-titled local review | The critic composes R4 (no rename) with the recorded title-append follow-up into 'a mis-titled review cannot be corrected'; whether the contract gains a rename is the owner's call, and the unit under either answer pins the 'Set once' hint copy or replaces it. |
| `M8.7-g1` | Give the mock a reachable dirty: true | No mock fixture or dev control ever produces dirty: true, so Verify §3's banner leg is unrunnable and the spec never specifies the flag; the task assigns the mock dirty flag/fixture to the owner's decision (same unit as D9-g3). |
| `M8.8-g3` | Record OQ2's sign-off on the PR-path reconcile change or revert | OQ2 says the PR-path reconcile change needs sign-off before M8.8.3 lands; it landed with no ruling on the board. Record the ruling or revert with a test — the owner's call. |
| `M8.9-g1` | Rule on OQ2's copy: live-review UI copy or the guide alone | The owner's ruling 2 said the un-archived-until-sync cost must be carried into UI copy; it landed only in the guide. Whether the live-review copy (syncCostCopy/neverSyncedCopy) must say it or the guide suffices is the owner's narrowing to record. |

## M8.16 — docs & board drift (32)

| audit id | unit | reason |
| --- | --- | --- |
| `D3-g1` | Amend LOCAL_REVIEWS.md §3.1/§4.2/§8.6/§8 #23 to the landed schema and minting | LOCAL_REVIEWS.md §3.1/§4.2 describe MAX(id)+1 minting and a three-column UNIQUE; the tree has the generation column and the high-water meta rows under owner rulings R-A/R-B. Design prose only. |
| `D3-g2` | State the -uno exclusion in D3, §4.2 and the guide §3 | D3 and the guide §3 say any working-tree edit is outside the review and dirty trees get a banner; the code runs --porcelain=v1 -uno under M8.3's ruling R-B, so untracked files raise no banner. Docs carry the exclusion. |
| `D3-g3` | Say direct mode alone in D5 and the index.ts comment | D5 says 'direct/broker mode'; only mainDirect builds the local surface and run-modes/index.mdx already says direct alone. Design wording. |
| `D3-g5` | Correct D2's claim about the mock router's positive gate | D2 and §3.1 claim both routers gate on Number.isInteger(n) && n > 0; the mock router's intParam checks only isInteger, identically on main. A design wording inaccuracy, not an M8 regression. |
| `D4-g1` | Amend LOCAL_REVIEWS.md §3.1/§4.2/§8.6/§8 #23 to the landed schema and minting | Same stale schema text as D3-g1 seen from §4: §4.2 DDL lacks generation and §3.1 says MAX(id)+1. Same prose unit. |
| `D4-g3` | Correct §4.1's etag and rateLimit rows | §4.1's etag ('hash of compareKeys') and rateLimit ('the mock's synthetic shape') rows describe neither transport precisely; behaviour is sound and pinned, the sentences are stale. |
| `D4-g4` | State the -uno exclusion in D3, §4.2 and the guide §3 | D3's `git status --porcelain` is `-uno` in the tree under ruling R-B; neither D3 nor §4.2's dirty line records the narrowing. Same unit as D3-g2. |
| `D5-g1` | Spell the pin ref name §5.1 uses | §5.1 spells a pin ref containing '...', which git rejects; the implementation writes <mergeBase>-<head>/base and /head, pinned by local-pins.test.ts. Design prose. |
| `D5-g2` | Replace §5's 'one flag' with the absent-client rule | §5 says provisionBlobs gains 'one flag'; the code omits the client instead, recorded in M8.3.6's Log and the blobs.ts docstring. Design prose. |
| `D5-g3` | Replace §5.1's mass-lost degradation with the re-sync refusal | §5.1 still presents mass-lost as the missing-object failure mode; M8.8.4's pre-flight refuses with a re-syncable not_found, pinned by reconcile.test.ts and local-objects-missing.test.ts. Design prose. |
| `D5-g5` | Point the design header at the local board | LOCAL_REVIEWS.md:5 says the Linear board carries the units; tracking moved to .claude/workstreams/. Header prose. |
| `D6-g1` | Say direct mode alone in D5 and the index.ts comment | D5's 'inside direct/broker mode' is the stale sentence; the user docs already say direct only. Same prose unit as D3-g3. |
| `D6-g2` | Correct M8.4.3 and its Context table: forbidden is the archived refusal | M8.4.3 item 2 and the Context table say forbidden is unreachable locally; since M8.9 the sink returns { status: 'forbidden' } as the archived refusal, pinned on three transports. Ticket prose. |
| `D7-g4` | Say direct mode alone in D5 and the index.ts comment | D5 and the index.ts:128 comment say 'direct and broker mode'; only mainDirect builds the surface. Prose in the design doc and a code comment; same unit as D3-g3. |
| `D7-g5` | Name the two new query keys in §7 | §7's 'no new query-key factories' is literally false (qk.branches, qk.localReviews); D2's payoff holds. Wording only. |
| `D8A-g2` | Reword the guide §5 'can go stale' to match the landed staleness | Guide §5's 'can go stale with zero head commits' is contradicted today; once M8.13's live-row unit lands it becomes true. The unit re-reads the sentence against the landed behaviour and keeps or rewords it. |
| `D8A-g3` | Move §8 cases 4/5 to first sync | §8 lists unrelated histories and shallow clone under Creation; createLocalReview resolves no SHAs so both surface at first sync, tested. Design placement prose (task: '§8 cases 4/5 at first sync'). |
| `D8A-g8` | Amend LOCAL_REVIEWS.md §3.1/§4.2/§8.6/§8 #23 to the landed schema and minting | §8.6/§4.2 say UNIQUE(repo, base_ref, head_ref); the store adds generation = 0 under ruling R-B. Same schema prose unit. |
| `D8B-g1` | Amend LOCAL_REVIEWS.md §3.1/§4.2/§8.6/§8 #23 to the landed schema and minting | §8 #23 says zero eviction exists and §3.1 says MAX(id)+1; the tree has deleteLocalReview/deleteImmutables/deleteBlobs and the high-water marks, delivered by M8.10/M8.2. Same schema prose unit. |
| `D8B-g2` | Add the path-keyed identity caveat to the guide §7 | Verified 3/3: guide §7 says a daemon that later gained an origin 'archives exactly as any other does', but a review created without an origin is path-keyed and never asked about (isOwnerNameShaped, intended per OQ7). One sentence in the guide (mirrored in direct.mdx and D1 of §8). |
| `D8B-g4` | Propose the smallest present-tense guard for the guides or record why not | No gate test reads the guides, so present-tense drift recurs unobserved; the task assigns proposing the smallest guard (or recording why not) to the docs ticket. |
| `D9-g5` | Amend LOCAL_REVIEWS.md §3.1/§4.2/§8.6/§8 #23 to the landed schema and minting | Same §3.1/§4.2 minting and UNIQUE staleness seen from §9. Same schema prose unit. |
| `EC3-g4` | Say direct mode alone in D5 and the index.ts comment | Observation, not a criterion gap: broker boot wires no local surface, so the design's D5 'direct/broker' is the stale sentence and the user docs' 'direct mode alone' is right. Prose, same unit as D3-g3/D6-g1/D7-g4. |
| `EC6-g1` | Amend MILESTONE.md criterion 6 to record R2's workspace-scoped chip | The chip's workspace scope is the owner's recorded ruling R2 (M8.7, 2026-08-14), so the behaviour is not a defect; what remains is MILESTONE.md criterion 6 never being amended to carry the deviation. The unpinned derivation is EC6-g2's. |
| `M8.1-g1` | Annotate M8.1 OQ5 with the delete-boundary supersession | M8.1's Log still records OQ5 as 'orphaned, never destroyed' while the tree (per the owner's ruling 1, BOARD.md:117) refuses while a draft holds text and removes empty draft/viewed rows; code and tests agree with the ruling, only the spec ticket lacks the supersession note. |
| `M8.10-g3` | Correct M8.10's Verify Log 'unedited' wording | The Log's Verify entry says reconcile.test.ts was 'unedited' while the PR adds eight unexpected() stubs; the behavioural claim holds, only the wording is wrong. |
| `M8.12-g1` | Note the MILESTONES.md M8.12 seed for the mirror step | MILESTONES.md seeds M8.1–M8.11 only; the mirror of M8.12–M8.17 is a separate step, so this unit only notes the seed is owed. |
| `M8.12-g2` | Rewrite M8.12's unit text to the no-force ruling and add Landmines | M8.12.1–.3 still describe the force-flag design the owner's ruling 1 struck; the code is right and the Log records the reshaping, but the unit text contradicts it and the ticket is the only M8 ticket without a Landmines section. |
| `M8.4-g1` | Correct M8.4.1/M8.4.6 Check literals (11 keys, five files) | M8.4.1's Check names 10 makeLocalDeps keys and M8.4.6's names four scanned files; the tree pins 11 and five. Ticket prose only. |
| `M8.7-g3` | Restate M8.7.7's corroboration against the true baseline | M8.7.7's Check claims zero diff vs main on shortcuts.ts/queries.ts, false since M8.6.5/M8.6.2/M8.9.6 touched them; a wording defect the Log already names. |
| `M8.8-g6` | Record M8.8 Verify clauses 6–8 | The Verify-run record lists clauses 1–5 only; 6 and 8 are proven by code, 7 is M8.8-g1. Record clauses 6–8 once the parity leg lands. |
| `M8.9-g2` | Record the broker archive-seam wiring's evidence status in M8.9's Log | The M8.9.3 Log claims broker-mode archive-seam wiring with no evidence; broker mode wires no local surface (EC3-g4) so the pairListingFor(pollClient) seam is inert. The task routes the broker wiring note to prose: record its evidence status and inertness in the ticket Log. |

## M8.17 — close-out (6)

| audit id | unit | reason |
| --- | --- | --- |
| `M8.12::Verify 1` | Re-run M8.12's Verify 1 files on main when marking it Done | The only non-durable parts are the red-first Log claims and mode-copy.test.ts not being run by the auditor; the close-out's full gate on main is the run that ticks it when M8.12 moves to Done. |
| `PRCHAIN-g1` | Build the merge-day checklist from the PRCHAIN facts | delete_branch_on_merge=false means every PR keeps its chain base after its predecessor merges; the merger must retarget to main or delete the merged head (admin bypass only, deletion rule on ~ALL). Pure merge process. |
| `PRCHAIN-g2` | Build the merge-day checklist from the PRCHAIN facts | Squash/rebase would give main a non-ancestor SHA and make every retargeted PR show its predecessors' commits; the checklist must say MERGE COMMITS. |
| `PRCHAIN-g3` | Build the merge-day checklist from the PRCHAIN facts | All fifteen PRs are BLOCKED/REVIEW_REQUIRED with the admin bypass as the only path — matches the recorded admin-only ruleset memory; the checklist records who merges and how. |
| `PRCHAIN-g4` | Build the merge-day checklist from the PRCHAIN facts | No required_status_checks rule, a recorded deferral (revu-merge-gating memory); the checklist must say eyeball CI per PR before pressing merge. |
| `PRCHAIN-g5` | Build the merge-day checklist from the PRCHAIN facts | m8.3/m8.4 are checked out in prunable scratchpad worktrees; `git worktree prune` before touching those branches is a merge-day step. |

## Covered by another finding's unit (30)

| audit id | disposition | reason |
| --- | --- | --- |
| `D4::4.1-mutable-empty` | D4-g2 | The unread mutable.checks is D4-g2's unit. |
| `D6::§6 #10` | D6-g3 | The unpinned conflict unreachability is D6-g3's unit. |
| `D7::guide-archived-read-only` | D7-g2 | The guide's unqualified 'read-only' moves with OQ10's ruling. |
| `D7::guide-local-review-section-position` | D7-g1 | The all-archived ordering is D7-g1's behaviour unit, which also settles the guide/docstring wording. |
| `D7::§7-8` | D7-g3 | The untested palette Go entry is D7-g3's unit. |
| `D8A::docs-guide-§5` | D8A-g2 | The 'can go stale' sentence is D8A-g2's prose unit, re-read after D8A-g1 lands. |
| `D8A::§8.13` | D8A-g1 | The unreachable baseMoved is D8A-g1's live-row unit. |
| `D8B::docs:local-review.mdx §7` | D8B-g2 | The over-broad archive-coverage clause is D8B-g2's guide sentence. |
| `D9::D3-in-the-oracle (D6)` | D9-g3 | The mock never producing dirty: true is D9-g3's ruling. |
| `D9::doc: guides/local-review.mdx §2` | D9-g1 | The guide §2 ordering claim is settled by D9-g1's behaviour unit. |
| `D9::doc: guides/local-review.mdx §7 callout` | D9-g4 | The unpinned archived-pair re-create is D9-g4's conformance unit. |
| `EC2::clause 1` | EC2-g1 | The missing local new-commit → re-sync → reconcile walk is EC2-g1's unit. |
| `EC2::clause 3` | EC2-g2 | The absent real `git rebase` walk is EC2-g2's unit. |
| `EC6::clause 0` | EC6-g3 | The umbrella is partial only because of the presence-only mode gates (EC6-g3) and the R2 chip (EC6-g1/g2). |
| `EC6::clause 2` | EC6-g2 | The unpinned rateAvailable derivation is the one hole in the cost-copy clause; the chip's scope is the recorded R2 ruling. |
| `M8.11::OQ3` | M8.11-g1 | The undecided local-scenario.test.ts question is M8.11-g1's ruling. |
| `M8.12::Verify 2` | M8.12-g4 | The in-browser delete path is M8.12-g4's e2e unit. |
| `M8.3::OQ-3` | M8.3-g2 | The open live-leg half of OQ3 is exactly M8.3-g2's ruling. |
| `M8.4::seed-verify-3` | M8.4-g2 | The optimistic round-trip hook test is M8.4-g2's unit. |
| `M8.6::OQ7` | M8.6-g3 | The base_defaulted preselection test is M8.6-g3's unit. |
| `M8.6::Verify-6` | M8.6-g5 | The unrun browser leg on the enabled wiring is M8.6-g5's e2e unit. |
| `M8.6::seed-2c` | M8.6-g1 | The dirty badge render assertion is M8.6-g1's unit. |
| `M8.6::seed-3b` | M8.6-g4 | The palette Go entry pin is M8.6-g4's unit. |
| `M8.6::seed-verify-c` | M8.6-g4 | The chord half is pinned; the palette discoverability half is M8.6-g4's unit. |
| `M8.7::R7` | M8.7-g2 | The dirty-before-author ordering pin is M8.7-g2's unit. |
| `M8.7::ticket-verify-3` | M8.7-g1 | The walk's only NOT RUN leg is the dirty banner, which M8.7-g1's mock-dirty unit makes runnable. |
| `M8.8::M8.8.3` | M8.8-g1 | Bullet (3), the real-mock parity leg, is M8.8-g1's unit. |
| `M8.8::seed-4` | M8.8-g2 | Read-only after a vanished branch is M8.8-g2's behaviour unit. |
| `M8.8::verify-7` | M8.8-g1 | Verify 7 is the missing parity leg itself. |
| `M8.9::OQ2` | M8.9-g1 | The copy-placement narrowing is M8.9-g1's ruling. |

## Accepted as not-a-defect (challenge these) (11)

| audit id | disposition | reason |
| --- | --- | --- |
| `D5::§9-1` | — | A non-goal still true on the tree; the audit itself says no test is expected for a non-goal and the doc is not stale here. |
| `D5::§9-4` | — | A non-goal still true (one per-daemon SQLite file); nothing §9 defers was delivered, so §9 is not stale and there is no absence to pin. |
| `D6::§6 #11` | — | The design's own sentence says the idempotency re-check and 422 path are deliberately dropped; M8.4.3 items 2–3 record it and the consequence half is pinned ('a draft deletion that fails after the review landed is reported as a storage failure'). An absence cannot be exercised. |
| `M8.3::ticket-verify-6` | — | A record of past break-observe-revert runs cannot be a property of the tree; the audit confirms the permanent paired controls that replaced them are present and cited (M8.3's Testing exceptions). Nothing a unit could add. |
| `M8.4::ticket-verify-2` | — | The 'demonstrated red' half is a Log observation; the durable half (five-file set, non-empty reads, fixture-importing-client detection, the walk finding the real client) is in the tree per the audit. The scope extension of that guard rail is EC3-g1's own unit. |
| `M8.5::TV.manual-drill` | — | The M8.5 ticket records the drill as corroboration by design ('neither guards anything after the day it runs'); its incomplete draft/submit legs are covered durably by local-reviews-serve.test.ts and e2e/local-review.ts, which create and submit against a direct daemon with no origin. |
| `M8.6::Verify-7` | — | The ticket itself defines the durable half as the pre-extraction green run; a screenshot diff against main is meaningless once the chain merges, and the GitHub-section tests pin today's row behaviour. Nothing a unit could close. |
| `M8.7::seed-verify-f` | — | Byte-identity of the assembled PrLayout is recorded as not test-expressible (M8.7 testing exception 2); every github-mode string is pinned per-block with the 'asked both ways' and 'no sentence answers the same' guards, and the residual is a diff against a main that ceases to exist at merge. |
| `M8.7::ticket-verify-2` | — | Each absence assertion sits beside a positive control in the same suite plus the module-wide same-answer guard, so none is vacuous by inspection; the historical reds are Log observations no unit can re-create. |
| `M8.7::ticket-verify-4` | — | Same corroboration-only claim as seed-verify-f (the /pr/347?mock=1 walk); strings and rows are proven, full-page identity is recorded as not test-expressible. |
| `M8.9::verify.e2e-both-halves` | — | A one-time live-host observation by design (M8.9 Testing exceptions); it ran on 2026-09-02 against revu-sandbox#6 (commit 9c182ec) and the fork half stays in-gate. The critic confirms it hides nothing new. |

## Refuted by verification (1)

| audit id | disposition | reason |
| --- | --- | --- |
| `M8.2-g1` | — | Refuted 2/3 in verified_gaps; the mint's BEGIN IMMEDIATE dedupe makes the UNIQUE clause a second line of defence and Check (2) demanded only the column pin. |

## Triage notes

Item ids are not unique across audits (ticket-verify-2 appears in M8.4 and M8.7; OQ2/OQ3 appear in several), so every weak item is keyed as `<audit key>::<item id>` exactly as the audit JSON's `key` field spells it (M8.3, M8.4, …, EC2, EC6, D4, D5, D6, D7, D8A, D8B, D9). Gap ids are used verbatim. Totals: 99 gaps + 47 items = 146 assignments; gaps by ticket — M8.13: 11, M8.14: 38, M8.15: 12, M8.16: 32, M8.17: 5, REFUTED: 1 (M8.2-g1); items — COVERED: 30, ACCEPTED: 11, M8.14: 3, M8.15: 2, M8.17: 1.

Seams read to decide the ambiguous cases: packages/app/src/api/mock/local.ts listLocalPullRows (docstring: compare key 'read from the ref tips as they are NOW, not from the last sync') — so D8A-g1/M8.8-g4 are a revud conformance fix, not a ruling (M8.13); the mock's createLocalReview uses the same isValidRefName/normalizeRefName as revud's qualifyRef (local.ts:306-314, local-surface.ts:565-583), so M8.3-g1's foreign-namespace pass-through is spec-consistent and only the dead normalizeRef and its orphaned rejection table are debt (M8.14); no *.test.ts references scripts/conformance-matrix.ts, so M8.11::verify-3's control (a) lacks a durable half (M8.14).

Ambiguous ids and why: (1) D8A-g5 (OQ8 corrupt-row 'Re-sync to rebuild') — placed in M8.13 on the assert-the-advice-works landmine, since treating an unreadable row as absent on re-sync needs no design call; if the owner sees a repair-vs-overwrite policy question it belongs in M8.15. (2) M8.5-g3 — the gap's literal remedy is a BOARD.md line (M8.16), but the task's M8.15 bin/revu ship-or-defer question closes it under either answer, so it sits with the ruling. (3) M8.9-g2 — could be a pairListingFor test (M8.14) but the task names it a prose note; EC3-g2's boot test in M8.14 will exercise the direct-mode seam anyway, and broker mode wires no local surface. (4) D8A-g7 has two halves; assigned M8.14 for the remote-tracking-base real-git leg, its dirty-fixture half rides D9-g3 in M8.15. (5) D8A-g2 (guide 'can go stale') becomes TRUE once M8.13's live-row unit lands, so the M8.16 unit is a re-read-and-keep-or-reword, not a straight rewrite. (6) D8A-g3 also names a vacuous app-side create-error test (a hand-written 'unrelated histories' message the server never sends at create); assigned M8.16 for the design placement — the M8.14 author may fold that test into EC2/D8A work. (7) EC1-g1 and EC5-g1 have behaviour-flavoured closers (a real request counter; a leg H over HTTP) but no product behaviour changes; both kept in M8.14 as the task lists them. (8) EC6-g1 is behaviourally an owner ruling (R2) — not ACCEPTED because MILESTONE.md criterion 6 still carries the unamended text; the prose fix is the residual. (9) ACCEPTED (11) is confined to historical red/walk claims whose durable controls the audit confirms in-tree (M8.3::ticket-verify-6, M8.4::ticket-verify-2, M8.7::ticket-verify-2, M8.7::seed-verify-f, M8.7::ticket-verify-4, M8.6::Verify-7, M8.5::TV.manual-drill, M8.9::verify.e2e-both-halves), two true non-goals (D5::§9-1, §9-4) and a drop the design itself specifies (D6::§6 #11) — the last carries a recorded residue (a resubmit after a failed draft delete materializes comments twice) that could become an M8.13 hardening if the owner disagrees with the design's stated drop. (10) M8.12::Verify 1 went to M8.17 rather than ACCEPTED because the close-out's gate run on main is a real run that ticks it.

The critic's three unmapped findings (ruling 4's live-pin bound, deleting an archived review, rename for a mis-titled review) and the stale board arithmetic (M8.10 at 4/7, units summing to 98) have no audit ids; they belong to M8.15 (first three, as the task scopes) and M8.16/M8.17 (board arithmetic) and should be seeded there directly.
