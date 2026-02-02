---
title: "Operational Version Control for OCR"
published: 2026-01-27
description: Patches, branches, and rebase in a manga reader.
tags: [mokuro, ocr, version-control, systems-design]
category: Projects
draft: false
---

I’m building a manga reader where you can fix OCR mistakes while you read.

Changing text is easy. Making those changes *collaborative* is not.

- There’s an official OCR that can be improved over time.
- Readers want to make private fixes as they notice errors.
- Some readers want to contribute those fixes back.
- When the official OCR changes, private fixes shouldn’t quietly drift onto the wrong lines or disappear.

That’s a version control problem, and not one that maps cleanly to Git.

OCR is **structured, spatial data**. It isn’t just text. Edits have *intent* (replace this line, remove that block, fix reading order), not just before/after states. Users expect undo, private history, and safe reconciliation when the upstream OCR changes.

This post describes a **patch-based, operational version control system** designed specifically for OCR editing. It focuses on the *ideas and tradeoffs* behind the design. Full mechanics and edge cases are linked separately in the spec and appendix.

If you just want the high-level model, Sections 1–3 are enough. Later sections go deeper into rebase, conflict handling, and performance.


## 1. Problem and constraints

The UI is straightforward: render OCR text (lines and blocks with bounding boxes) as an overlay, let the reader fix mistakes they notice, and keep reading.

The system problem starts once OCR becomes shared state.

- There is an official (“canonical”) OCR for each volume or page.
- Readers want to make fixes as they go, but those edits should be private by default.
- Some readers want to contribute fixes back to the canonical OCR.
- The canonical OCR can change later (better model, better scan, admin cleanup).

When that happens, private edits shouldn’t silently drift onto the wrong content or disappear.

This is version control, but it’s **operational rather than snapshot-based**. OCR data is structured JSON (pages → blocks → lines + geometry), and edits are best understood as **atomic operations over that structure**, not as diffs between whole-document snapshots.

### 1.1 Requirements

From the user’s point of view:

- Private edits must be isolated by default.
- When the canonical OCR changes, private edits must either adapt forward or surface a clear conflict.
- Undo and redo should behave like they do in a normal editor.
- History should be inspectable enough to answer “what happened?”

From a collaboration standpoint:

- Multiple users may edit the same volume concurrently, but not necessarily in real time.
- The canonical OCR is controlled by an admin or maintainer; user edits are proposals until accepted.

From a data and performance standpoint:

- OCR volumes are large, but most edits are small and localized.
- Rendering must be fast enough for a reader; we can’t replay thousands of edits on every page load.
- Storage should be incremental: store changes, not full copies of OCR per user.

### 1.2 Non-goals

This design explicitly does **not** attempt to solve:

- Real-time multi-cursor collaborative editing (OT/CRDT-style).
- Automatic semantic merging of arbitrary text edits.
- Treating OCR as “just text.”

OCR overlays are spatial and structured. Geometry, ordering, and stable identities matter, and the system is shaped around those constraints.

## 2. Why snapshots (and Git) don’t map cleanly

Snapshot-based version control is not appropriate here because it doesn’t exploit the structured nature of OCR data, and instead pushes the burden of interpretation onto the user. That tradeoff is acceptable for developers editing source code, but not for non-technical readers correcting strict, spatial data.

OCR editing requires the system to understand *what kind of change* was made and *what object* it targeted, and then provide clean, well-scoped choices when reconciliation is required. Snapshot-based systems track only before/after states. Once edit intent is lost, reconciliation becomes a human inference problem.

### 2.1 Snapshots discard structure and intent

OCR in a reader is not flat text. It is structured, spatial data:

- pages contain blocks
- blocks contain lines
- lines have both text and geometry

Edits operate on these semantic units. A user usually means “replace the text of this line,” “remove this block,” or “fix the reading order”, not “change some bytes in a JSON file.”

Snapshot-based diffs discard this information. They record that *something* changed, but not **what kind of change it was** or **which logical object it was meant for**. Was a line replaced, moved, or deleted? Was a block reordered or rewritten? That intent is lost.

Once intent is gone, reconciliation becomes a human inference problem. The system can no longer adapt edits mechanically and instead asks the user to interpret diffs and make judgment calls. This tradeoff is acceptable for developers editing source code, but it breaks down for non-technical users working with strictly structured, spatial data.

### 2.2 Snapshots require lots of storage

Snapshot-based storage is also a poor fit for OCR from a practical standpoint.

OCR volumes are large, while most edits are small and localized. Storing full snapshots per user or per edit duplicates large amounts of unchanged data and increases storage and bandwidth costs. Incremental updates become more expensive than necessary.

This is a real concern, but it’s not the core failure mode. Even if storage were free, snapshots would still lack the structural and semantic information needed to reconcile edits safely.

### 2.3 What we borrow from Git (and what we don’t)

We borrow Git’s mental model.

Branches, a canonical mainline, HEAD pointers, and rebase as “changing the past and reinterpreting the future” all apply cleanly to OCR editing.

What does not transfer is Git’s **unit of change**.

Git is built around snapshotting files and asking users to resolve conflicts by interpreting diffs. For OCR, the system should do that work itself by preserving structure and intent: storing edits as typed operations over structured objects, and reconciling them mechanically whenever possible.

That leads to an operational model: immutable patches, branch pointers, and rebase as a transformation of meaning rather than a replay of states.

## 3. Data model: patch tree + per-user branches

Once edits are represented as explicit operations, the remaining problem is bookkeeping.

The system needs to:
- store edit history without duplicating OCR data,
- give each user a private, linear editing experience,
- and support undo, rebase, and reconciliation predictably.

The solution is a small set of structural choices: immutable patch nodes, lightweight branch pointers, and a clear boundary between shared history and private work.

### 3.1 Patch nodes: immutable edit history

Each edit produces a single **patch**: an immutable record of one atomic operation against the OCR structure.

A patch stores:
- a unique ID
- a pointer to its parent patch
- metadata (author, timestamp, volume)
- the operation itself (replace text, remove block, reorder lines, etc.)

```
Official (Admin):
P0 ───> P1 ───> P2 ───> P3 (HEAD_Admin)
        │
        └─────> U1 ───> U2 (HEAD_User)
                ▲
                │
            (ROOT_User)

```

Patches are never modified after creation. This single decision makes undo, branching, and reconciliation predictable: history can be navigated and reinterpreted, but not rewritten in place.

### 3.2 Branches are pointers, not copies

A user does not own a copy of the OCR document. They own a **branch record**: a small piece of metadata that says which patch represents their current view.

A branch record contains only pointers:
- which patch is currently visible (HEAD),
- and, if applicable, where the user’s private history begins.

No OCR content lives in branches. Multiple users can reference the same patch history without duplicating data.

This makes branching cheap and predictable: creating or abandoning private history is just pointer movement, not copying or deleting document state.


### 3.3 `rootPatchId`: collapsing a tree into a linear timeline

Globally, patch history forms a tree. From a user’s perspective, however, history must feel **linear**.

Undo, redo, and inspection all assume a single timeline: “what happened before” and “what happened after.” Users should never have to reason about branching structure.

`rootPatchId` is the mechanism that bridges these views.

For a given user, `rootPatchId` marks the first patch that belongs to their private history. Everything before it is treated as shared, immutable context. Everything after it forms a single linear chain that behaves like a normal editor timeline.

If `rootPatchId` is null, the user has no private edits and is simply tracking the canonical OCR. Once the user makes their first edit, `rootPatchId` is set, and a private timeline is established.

The exact pointer mechanics and edge cases are spelled out in the spec. The key idea is simple: **each user always experiences history as a single, unambiguous sequence**, even though the underlying storage is a tree.



```
Official (Admin):
P0 ───> P1 ───> P2 ───> P3 ───> P4 (HEAD_Admin)
                │       ▲
                │       │
                │    (HEAD_A)
                │    (ROOT_A: Ø)
                │
                ▼
                U1 ───> U2 (HEAD_B)
              (ROOT_B)
```

### 3.4 Snapshots are caches, not history

To render pages efficiently, the system maintains materialized OCR snapshots.

A snapshot corresponds to a specific patch. If the branch HEAD matches that patch, the snapshot can be used directly. Otherwise, patches are replayed incrementally to bring it up to date.

Snapshots improve performance, but they are never authoritative. Patch history is the source of truth.

This separation is intentional: correctness comes from history, speed comes from caching.


### 3.5 A note on system rules

This model relies on a few simple rules: history is immutable, branches move only by pointer updates, and redo is never ambiguous.

These constraints keep behavior predictable and prevent entire classes of edge cases. The full list is included in the appendix for reference.

## 4. Patch operations: a minimal language for OCR edits

For reconciliation to work, the system needs to preserve *what kind of edit* the user intended to make.

Instead of storing arbitrary JSON diffs, edits are represented as a small set of **typed operations** over the OCR structure. These operations correspond directly to editor actions: replacing text, removing a block, or fixing reading order.

This keeps intent explicit and makes replay, undo, and rebase mechanically tractable.


### 4.1 Structured document and typed operations

The underlying OCR data is structured JSON. In simplified form, it looks like:

- a volume contains pages
- pages contain blocks
- blocks contain lines
- lines have both text and geometry

Edits never operate on the document as a flat blob. They always target a specific semantic unit: a page, block, or line.

Each patch represents one **typed operation**, corresponding directly to an editor action:

- `replace`: update a leaf value (for example, line text or geometry)
- `add`: insert a structural unit (a line or block)
- `remove`: delete a structural unit
- `reorder`: change the order of siblings within a container
- `genesis`: introduce the initial document state

These operations are intentionally coarse. They preserve *what kind of change* the user intended to make, which is essential for replay and rebase.

Not all edits operate at the same level. Some change a single value in place; others add or remove entire structural units that must move together (for example, a line’s text and its coordinates).

To reflect this, patch values fall into two categories:

- **Fine values**: leaf-level fields that can be replaced directly (strings, numbers, geometry).
- **Structural values**: grouped units that must be added or removed atomically.

This prevents partial updates that would leave the document in an inconsistent state.

### 4.2 Addressing targets with paths

Each patch targets its edit using a path that reflects the document structure, for example:

- `/pages/{p}/blocks/{b}`
- `/pages/{p}/blocks/{b}/lines/{l}`

Paths are intentionally constrained. Only paths that correspond to valid editor actions are allowed.

Two conventions matter:

- Indices may equal `array.length` to indicate insertion at the end.
- Structural edits never target raw parallel arrays directly. Geometry edits go through the line abstraction, so text and geometry stay in sync.

These constraints eliminate entire classes of invalid or ambiguous patches before they can be written.

### 4.3 Old values and validation

Destructive operations (`replace` and `remove`) carry an `old_value`.

This serves two purposes:

- It makes patches invertible, which is required for undo.
- It provides a cheap validation check during replay and rebase.

If the current document state does not match the expected `old_value`, the patch cannot be applied. That mismatch signals corruption or an invalid context, and the operation is rejected.

### 4.4 Why not use RFC 6902 (JSON Patch)

At a glance, this patch language resembles RFC 6902 (JSON Patch): it uses `add`, `remove`, and `replace` operations targeted by paths.

The difference is not expressive power, but shape. Generic JSON Patch treats all changes as equivalent tree mutations. For OCR editing, that erases important distinctions about *what kind of edit* was intended.

A concrete example is reading order. Fixing reading order is common and intentional in manga OCR. Encoding this as a sequence of deletes and inserts obscures that intent and makes rebase and conflict handling much harder.

Instead, reordering is expressed explicitly as a permutation within a container. This preserves intent and allows reorder operations to be transformed mechanically, rather than inferred from index shifts.

RFC 6902 remains a good general-purpose format. For structured OCR data that must survive rebase and reinterpretation, a domain-shaped operation set makes intent explicit and reconciliation tractable.

## 5. Workflows: writing patches and moving pointers

With immutable patch history in place, most interactions reduce to two actions:

- write a new patch, or
- move a branch pointer.

History itself is never mutated. This keeps behavior predictable even as users undo, redo, fork, reset, and rebase.

### 5.1 Fork-on-write

A user starts in a clean state: they are effectively viewing the canonical OCR.

- their branch HEAD points at the current canonical patch
- they have no private history yet

  ```
  Official (Admin):
  P0 ───> P1 ───> P2 ───> P3 ───> P4 (HEAD_Admin)
                  ▲
                  │
               (HEAD_A)
               (ROOT_A: Ø)
  ```

On the first edit, the system forks:

- a new patch is created on top of the canonical HEAD
- this patch becomes the start of the user’s private history
- subsequent edits extend this private chain

From the user’s point of view, nothing special happens. They simply start editing. Internally, this is copy-on-write at the history level.

```
Official (Admin):
P0 ───> P1 ───> P2 ───> P3 ───> P4 (HEAD_Admin)
                │
                └─────> U1 (HEAD_A)
                        ▲
                        │
                     (ROOT_A)
```



From that point on, the user’s branch is a private history chain.

### 5.2 Creating an edit

Each editor action produces exactly one patch.

To apply an edit:

- validate the branch version (optimistic locking)
- write a new patch whose parent is the current HEAD
- advance the branch HEAD to the new patch

If the user had undone edits and applies a new patch, any abandoned redo future is normally discarded. This mirrors standard editor behavior.

One exception exists: if discarding the redo future would invalidate shared history, the system instead forks and establishes a new private base. The details are mechanical and spelled out in the spec.

### 5.3 Undo

Undo moves the branch pointer backward:

- the branch HEAD is set to its parent
- no patches are modified or deleted

Undo never mutates history. It only changes which patch the branch points to.

### 5.4 Admin undo and branch drag

Undoing edits on the canonical branch is more constrained.

Other users may have private histories built on top of canonical patches. Simply deleting or rewinding canonical history could strand those branches or make them unreplayable.

To handle this safely, the system uses **branch drag**:

- if undoing a canonical patch would invalidate exactly one downstream branch,
  that branch is “dragged” so it remains anchored to valid history
- if undoing would invalidate multiple branches, the undo is refused

Branch drag preserves two invariants simultaneously:
- canonical history can be corrected conservatively
- downstream user history remains well-defined

The exact pointer updates and edge cases are detailed in the appendix.

#### 5.4.1 Case A: a tracking user is “in the way”

Before:

```
P0 ───> P1 ───> P2 ───> P3 (HEAD_Admin)
                        ▲
                        │
                     (HEAD_A)
                     (ROOT_A: Ø)
```

Admin wants to undo P3 (move admin HEAD back to P2). After branch drag:

```
P0 ───> P1 ───> P2 (HEAD_Admin)
                │
                └─────> P3 (Relinquished from official)
                        ▲
                        │
                     (HEAD_A)
                     (ROOT_A: P3)
```

So:

- admin history rewinds (P3 is no longer on the official spine)
- user A keeps seeing the effect of P3, but now as a private fork

#### 5.4.2 Case B: a forked user depends on the patch being undone

Before:

```
Official (Admin):
P0 ───> P1 ───> P2 ───> P3 (HEAD_Admin)
                        │
                        └─────> U1 ───> U2 (HEAD_B)
                                ▲
                                │
                             (ROOT_B)
```

If admin removes P3 from the official spine, user B still needs P3 because their fork was built on top of it.

After branch drag:

```
Official (Admin):
P0 ───> P1 ───> P2 (HEAD_Admin)
                │
                └─────> P3 ───> U1 ───> U2 (HEAD_B)
                        ▲
                        │
                     (ROOT_B)
```

Now P3 is no longer “official,” but it remains the base of user B’s private history — so their fork stays anchored and replayable.

### 5.5 Redo

Redo moves the branch pointer forward.

In a history tree, a patch may have multiple children. To avoid ambiguity, redo must always have a single, well-defined target.



```
                               (ROOT_A)
                                  │
                                  ▼
                        ┌───────> A1 ───────> A2 (HEAD_A)
Official (Admin):       │
P0 ───────> P1 ───────> P2 ───────> P3 ───────> P4 (HEAD_Admin)
                        ▲           │
                        │           └───────> B1 ───────> B2
                     (HEAD_B)                 ▲
                                              │
                                           (ROOT_B)
```

When user B hits redo, should the pointer move to `A1` or `P3`? 

To make this deterministic, the system relies on two pieces of information:

- **Canonical successor**: each patch may explicitly mark which child belongs to the canonical history. This provides a fast, unambiguous “mainline” direction.
- **Local fork boundary**: if the user previously undid back to the point where their private history begins, redo prefers continuing into that private chain rather than jumping elsewhere.

When redo is requested, the system uses these mechanism to determin the definitive next patch.

The full disambiguation rules are mechanical and included in the spec.

### 5.6 Reset

Reset discards a user’s private history and returns them to tracking the canonical OCR.

Internally, this:
- prunes the private branch
- moves the branch HEAD back to the canonical HEAD

From the user’s perspective, this behaves like “throw away my local changes.”


### 5.7 Officialize

Officialization is an admin action: promote a user’s private edits to become the canonical OCR.

The simple case is a fast-forward:
- if the user’s HEAD is a descendant of the canonical HEAD,
  the canonical pointer is advanced

If the canonical history has moved independently, officialization becomes a reconciliation problem and is handled via the rebase workflow rather than being forced implicitly.

## 6. Rebase: reinterpreting edits under a changed past

Rebase is where the system earns its keep.

When the canonical OCR changes, a user’s private edits may no longer apply cleanly. The document state those edits were written against no longer exists verbatim.

Rebase exists to answer a single question:

> Given a new base document, what did these edits *mean*, and how do we express that same intent now?

This system treats rebase not as patch replay or state merging, but as **reinterpretation of intent under a changed context**.

### 6.1 When rebase is required

A rebase is required when:

- the canonical branch has advanced, and
- a user’s private history is no longer rooted directly on the current canonical head.

This can happen when the admin accepts other contributions, performs edits themselves, or when a user resumes work after being behind the official OCR.

Until rebase completes, the user’s private patches are no longer guaranteed to apply to the current document state.

### 6.2 Rebase as operation retargeting

Each private patch was authored against a specific document state.

When the canonical history changes, that state no longer exists exactly. Rebase does not merge document snapshots. Instead, it **retargets operations** so they continue to express the same intent under the new context.

The system models the change from the old canonical base to the new one as an **effect** on document structure:

- lines may move
- blocks may be reordered
- elements may be removed

Rebase walks forward along canonical history, accumulating these effects, and transports each private patch through them.

Conceptually, two things happen at each step:

- **Patch reinterpretation**: the user patch is rewritten so it still targets the intended object under the shifted structure.
- **Effect accumulation**: the effect is updated to reflect how this patch further changes the context for downstream edits.

Rebase completes when the user’s rewritten patches have been reattached on top of the current canonical head.

Operationally, no existing patches are modified. Rebase produces a *new sequence of patches* that represent the same user edits, but interpreted under the new history. Branch pointers are then updated to point to this rebased chain.


### 6.3 Conflict detection

A conflict occurs when a patch’s intent can no longer be interpreted unambiguously.

Examples include:

- the target line or block no longer exists,
- the expected `old_value` no longer matches,
- a reorder refers to elements that were deleted upstream.

In these cases, the system stops. The patch is marked as conflicted and requires user input.

Conflicts are not failures of the system. They mark the boundary where intent preservation becomes ill-defined and a choice must be made explicitly.


### 6.4 Why this works

Rebase is possible because patches preserve intent.

- Operations are typed.
- Targets refer to semantic objects.
- Destructive edits are checkable.
- Reordering is explicit.

These properties make it possible to reinterpret edits mechanically under a changed past. Snapshot-based diffs lack this information and must instead ask users to infer intent manually.

### 6.5 Complexity and termination

Rebase is structured as a finite process over two dimensions:

- upstream canonical changes, and
- downstream private edits.

Let $A$ be the number of canonical patches introduced since the user’s original base, and let $U$ be the number of private patches to rebase.

Each canonical patch induces an effect that must be transported through each private patch. Rebase work is therefore bounded by:

\[
\mathcal{O}(AU)
\]

This reflects the true cost of intent preservation: every private edit must be reconsidered under every upstream change that occurred since it was authored.

Termination is guaranteed. Both $A$ and $B$ are finite, and each transport step produces a definitive outcome. Rebase is a finite double loop, not an open-ended negotiation or search.

## 7. Conflict resolution

Most interactions between edits can be handled mechanically.

As upstream changes shift structure, indices move, elements reorder, and content updates propagate. As long as a user patch can still be reinterpreted unambiguously, it is retargeted and applied automatically.

Conflict resolution is only needed when that reinterpretation becomes ill-defined.


### 7.1 Two resolution semantics

All conflicts are resolved by choosing one of two **consistent interpretations of history**.

This is not about merging states. It is about deciding how to interpret user intent under a changed past.

**`keep_admin`**

- The system assumes that given the updated canonical context, the user would *not* have made this edit.
- The conflicting user patch is dropped or rewritten away.
- Future edits are interpreted as if the patch never existed.

**`keep_mine`**

- The system assumes that even if the upstream changes had already been present, the user would still have made an edit that results in the same outcome.
- The user’s intent is preserved by rewriting history so the patch remains meaningful under the new context.

In both cases, the rendered document state is consistent. What differs is the counterfactual assumption about user intent.

### 7.2 Conflict resolution as history reinterpretation

Conflict resolution is a decision about how to reinterpret history.

Under `keep_mine`, the system rewrites the user’s patch so it behaves as if it had been authored against the updated canonical state all along. Any upstream effect that caused the conflict is absorbed.

Under `keep_admin`, the system does the opposite. The user patch is removed, and its inverse is conceptually folded back into the upstream effect so downstream edits remain consistent.

ascii: conflicting user patch being either absorbed into history or erased from it

Both resolutions preserve consistency. Neither guesses. The difference lies in which counterfactual history the system chooses to commit to.

### 7.3 What counts as a conflict

A conflict occurs only when intent preservation becomes ambiguous.

Typical cases include:

- editing content inside a subtree that was deleted upstream,
- both sides modifying the same field incompatibly,
- structural edits that invalidate assumptions made by later patches.

When this happens, the system stops rather than guessing. Conflicts mark the boundary where mechanical reinterpretation ends and human intent must be made explicit.

### 7.4 Resolution mechanics

The full resolution rules are specified as an exhaustive, deterministic rewrite system covering how every operation type interacts with every upstream change.

This includes:
- structural intersections,
- content conflicts,
- dead-zone and resurrection cases,
- and the exact rewrites produced under each resolution.

These details are included in the appendix for reference. They are intentionally not reproduced here, as the goal of this section is to explain *what conflicts mean*, not to enumerate every case.

## 8. Making this fast: snapshots, replay, and compression

All of the reconciliation logic so far is only useful if it performs well enough to be used interactively.

At runtime, the system needs to answer one question cheaply:

> What is the current document state for this branch?

The performance story has three parts:
- snapshots for fast reads,
- replay as a fallback,
- and compression to keep histories from growing without bound.

### 8.1 Snapshots as cached state

A snapshot is a cached materialization of the document at a specific patch.

Each branch tracks:
- which patch the snapshot corresponds to, and
- which patch it wants to render.

If these match, the snapshot can be used directly. Otherwise, the system loads the snapshot and replays only the missing patch ancestry to bring it up to date.

Snapshots exist purely for performance. They never define correctness. Patch history remains the source of truth.

### 8.2 Replay as the fallback

When a snapshot is missing or out of date, the system reconstructs the desired state by replaying patches.

There are two distinct failure modes:

- **Stale snapshot**: the snapshot exists, but the branch HEAD has moved elsewhere.
- **Invalid snapshot**: the snapshot is missing or corrupted.

In the stale case, recovery is incremental:

- determine the patch ancestry between the snapshot patch and the branch HEAD,
- apply the missing patches in order,
- and advance the snapshot pointer.

In the invalid or missing case, recovery is conservative:

- discard the snapshot,
- replay patches from genesis to the branch HEAD,
- and regenerate a fresh snapshot at the HEAD.

Undo, redo, reset, and rebase all funnel into this same replay mechanism. They differ only in how branch pointers move and which replay range is required.

Replay is kept safe and efficient by cheap validation:

- optimistic locking via branch versions,
- and `old_value` checks for destructive edits.


### 8.3 Compression: removing unnecessary history

Over time, patch histories grow. Long histories increase replay cost and make rebase more expensive.

Compression reduces history length *without changing semantics*. Crucially, it does not introduce a new algorithm.

Compression uses the **exact same rebase machinery**, verbatim.

Rebase asks:

> How does the future adapt if a patch is added to the past?

Compression asks the inverse question:

> How does the future adapt if a patch is removed from the past?

Operationally, compression is implemented by treating “remove this patch from history” as a counterfactual upstream change and then running the same rebase logic:

- the same effect representation,
- the same patch–effect transformation rules,
- and the same conflict handling semantics.

In particular, the patch–effect transformation table — which defines how every operation type is rewritten under every upstream structural change — is reused unchanged.

To test whether a patch is necessary:

1. Temporarily remove the candidate patch from the private history.
2. Treat its removal as an upstream effect.
3. Run the standard rebase machinery under `keep_mine` semantics to rewrite later patches.
4. If the rewritten future produces an identical document state, the patch can be dropped. Otherwise, it must be kept.

No special cases are added for compression. If rebase can compensate for the removal, the history is redundant; if it cannot, the patch is essential.

### 8.4 Summary

Performance comes from separating concerns:

- history defines correctness,
- snapshots provide speed,
- replay bridges the two,
- and compression keeps histories manageable.

Rebase, conflict resolution, undo, and compression are all variations of the same idea:

- adjust history,
- rewrite future edits to match new assumptions.

This keeps collaboration predictable without sacrificing performance.

## 9. Conclusion

Collaborative OCR editing is a reconciliation problem.

Edits may be independent or interfering. History may change after work has already been done. Intent must be preserved explicitly if private fixes are going to survive upstream changes without silent corruption.

OCR in a reader is not a flat text file. It is a structured, spatial document where edits have **semantic meaning** (replace versus delete versus reorder) not just before/after states. That is why this system is operational rather than snapshot-based.

The core design choices follow directly:

- represent edits as a small, typed patch language over structured OCR data,
- store history as immutable patches,
- represent branches as pointers into that history, with a clear boundary between shared past and private work.

With that foundation, higher-level behavior becomes mechanical:

- undo and redo are pointer movement,
- rebase reinterprets intent under a changed past,
- conflicts surface only when intent becomes ambiguous,
- snapshots accelerate reads without defining correctness,
- and compression reuses the same rebase machinery to remove redundant history.

What makes the system work is not any single feature, but the fact that **all reconciliation flows through the same logic**. Rebase, conflict resolution, undo, and compression are variations of the same operation: adjust history, then rewrite future edits to match the new assumptions.

This is not a general-purpose version control system. It is deliberately shaped around the structure and semantics of OCR data. Within that scope, it makes collaboration predictable, explicit, and safe — without asking users to reason about diffs, snapshots, or history rewriting themselves.

## Appendix A: Rebase Semantics (Reference)

This appendix specifies the **exact mechanics** used during rebase and compression.

It defines how a user patch is rewritten when transported through an upstream effect, including:
- intersection classification,
- index and path transport rules,
- conflict detection,
- and the concrete rewrites produced under each resolution.

This material is **not required** to understand the design at a conceptual level. It exists to make the system fully specified and implementable.

All rules in this appendix are deterministic. There are no heuristics, fallbacks, or “best effort” cases. If a case is not covered here, it is considered a bug.

### A.0 Conventions

This appendix uses the following conventions.

**Structural effects**

- `shift_up(A, k)`: an element was inserted into array `A` at index `k`.
- `shift_down(A, k, D)`: the element at `A[k]` was removed; `D` is the deleted payload.
- `permute(A, π)`: array `A` was reordered by permutation `π`.
- `content(P, vA)`: the leaf at path `P` was replaced with value `vA`.

**Permutation convention**

- `π(i)` maps **old index → new index**.
- Composition is function composition, where the inner permutation is applied first:
  \[
  (\text{outer} \circ \text{inner})(i) = \text{outer}(\text{inner}(i))
  \]

This matches the convention `result[i] = outer[inner[i]]`.

---

### A.1 Intersection classification

Each rebase step classifies the interaction between a **user patch** and an **upstream effect**.

Classification depends only on the patch targets and the effect target, not on history or context.

The following classes are exhaustive.


| Type | Meaning | What Transforms |
|------|--------|------------------|
| `no_hit` | No overlap between user patch and effect | None |
| `collateral_ancestor_hit` | Effect is structural on an array `A`, and the user patch targets a descendant inside `A` (but not at the same array level) | User patch path (index transport) |
| `collateral_descendant_hit` | User patch is structural on an array `A`, and the effect targets a descendant inside `A` | Effect path (index transport) |
| `sibling_hit` | Both are structural at the same array level | Both (mutual transport) |
| `direct_hit` | Exact target match at the same node | Conflict |
| `ancestor_hit` | User patch targets inside a subtree whose root node was affected | Conflict |
| `descendant_hit` | Effect targets inside a subtree whose root node was affected by the user patch | Conflict |

**Important nuance:** `shift_up` is treated as “inserting into a gap,” so it does not produce `direct_hit` / `ancestor_hit` with an element path; it interacts structurally (e.g., `sibling_hit` / `descendant_hit` / `collateral_hit` cases).

---

### A.2 Deterministic structural transforms (no conflict)

These cases transport paths or indices without invoking conflict resolution. Both the user patch and the effect remain valid after rewriting.

#### A.2.1 `collateral_ancestor_hit` (structural effect on array, user patch inside that array)

Let effect act on array `A` and user patch target `A/i/...` (so the first segment under `A` is an index `i`).

| effect.type | Index transport for user index `i` | Description |
|-------------|------------------------------------|-------------|
| `shift_up(A, k)` | `i' = i + 1` if `i ≥ k`, else `i' = i` | insertion pushes later indices right |
| `shift_down(A, k, D)` | `i' = i − 1` if `i > k`, else `i' = i` | deletion pulls strictly-later indices left |
| `permute(A, π)` | `i' = π(i)` | reorder maps old index to new index |

User path becomes `A/i'/...`. Effect itself is unchanged.

---

#### A.2.2 `collateral_descendant_hit` (user structural patch on array, effect inside that array)

Let user patch act on array `A` and effect target `A/i/...`.

| user.op | Index transport for effect index `i` | Description |
|---------|--------------------------------------|-------------|
| `add` at `A/k` | `i' = i + 1` if `i ≥ k`, else `i' = i` | insertion shifts later effect targets right |
| `remove` at `A/k` | `i' = i − 1` if `i > k`, else `i' = i` | deletion shifts strictly-later effect targets left |
| `reorder(A, ρ)` | `i' = ρ(i)` | reorder maps old index to new index |

Effect path becomes `A/i'/...`. User op is unchanged.

---

#### A.2.3 `sibling_hit` (both structural on the same array)

Here both sides are structural on the same array `A`. Rebase proceeds as **mutual transport**:
1) transport the **user index/permutation** through the effect, and
2) update the **effect index/permutation** to account for the user structural change.

##### (a) user `reorder(A, ρ)` vs effect `shift_up(A, k)` or `shift_down(A, k, D)`

| effect.type | Description |
|------------|-------------|
| `shift_up(A, k)` | Extend the user permutation to length+1 to include the inserted element at index `k` (preserving relative order of existing elements). Then map the inserted element’s index through the extended permutation to determine the effect’s new index. |
| `shift_down(A, k, D)` | First map the deleted element’s index through the user permutation to determine where that element would be after user reorder; then shrink the user permutation to length−1 by removing the deleted element’s slot. |

**Note:** user `reorder` vs effect `permute` is treated as `direct_hit` (`reorder_collision`), not a sibling transform.

##### (b) user `add/remove` vs effect `shift_up/shift_down`

Let user index be `u` (for `add` or `remove` at `A/u`) and effect index be `k`.

| effect.type | Transport user index `u` through effect | Then update effect index `k` through user structural change |
|------------|------------------------------------------|------------------------------------------------------------|
| `shift_up(A, k)` | `u' = u+1` if `u ≥ k`, else `u' = u` | if user inserts/removes at `u'` and `u' < k`, then `k` shifts by `+1` (insert) or `−1` (remove) |
| `shift_down(A, k, D)` | `u' = u−1` if `u > k`, else `u' = u` (the equality case is a `direct_hit` conflict) | if user inserts/removes at `u'` and `u' < k`, then `k` shifts by `+1` (insert) or `−1` (remove) |

##### (c) user `add/remove` vs effect `permute(A, π)`

| user.op | Description |
|---------|-------------|
| `add` at `A/u` | Expand effect permutation `π` to length+1 to account for the inserted element, then transport the user insertion index through the expanded permutation to get the rebased insertion index. The effect keeps the expanded permutation. |
| `remove` at `A/u` | Transport the user removal index through `π` to get the rebased removal index, then shrink effect permutation to length−1 by removing the removed slot. The effect keeps the shrunk permutation. |

---

### A.3 Conflict cases and resolution

Conflicts arise only when intent preservation becomes ambiguous.

Each conflict is resolved by choosing one of two interpretations:
- `keep_admin`: discard or rewrite the user patch and preserve the upstream effect,
- `keep_mine`: rewrite the user patch to remain meaningful and absorb the effect.

Every conflict listed below supports one or both of these resolutions. No conflict produces an undefined state.

| Intersection | effect.type | user.op | Conflict | Auto | keep_admin | keep_mine |
|---|---|---|---|---:|---|---|
| `direct_hit` | `shift_down` | `add` | `shift_down_into_add` | ✓ | keep patch; move delete index from `k` to `k+1` | — |
| `direct_hit` | `shift_down` | `remove` | `double_delete` | ✓ | drop patch; effect → identity | — |
| `direct_hit` | `permute` | `reorder` | `reorder_collision` | ✗ | drop user reorder; effect permutation becomes `ρ⁻¹ ∘ π` | keep reorder; rewrite to `π⁻¹ ∘ ρ`; effect → identity |
| `direct_hit` | `content` | `replace` | `content_conflict` | ✗ | drop user replace; keep effect | keep replace, but set `old_value := vA`; effect → identity |
| `ancestor_hit` | `shift_down` | any (inside deleted subtree) | `dead_zone` | ✗ | drop user op; but fold user change into deleted payload `D := Apply(D, r, user_op)` | resurrect: output `add` at deleted path with `D := Apply(D, r, user_op)`; effect → identity |
| `descendant_hit` | any | `remove` | `reverse_dead_zone` | ✗ | drop user remove; output `shift_up` reinserting the (updated) old payload | keep user remove but update `old_value` by folding admin change into it; effect → identity |
| `descendant_hit` | any | `add` | `effect_shift` | ✓ | keep patch; transport effect target path through the insertion (`i ≥ k ⇒ i+1`) | — |
| `descendant_hit` | any | `reorder` | `effect_shift` | ✓ | keep patch; transport effect target path through the reorder (`i → ρ(i)`) | — |

Where:
- In `dead_zone`, `r` is the relative path tail inside the deleted element: user targets `A/k/r`.
- In `reverse_dead_zone`, the “fold admin change into payload” applies the admin effect (converted to an op when possible) into the removed element’s payload at the appropriate relative tail.

**Invariant (operational):**
- `keep_mine` returns a concrete user op and absorbs the effect (`effect → identity`).
- `keep_admin` returns no user op (`op → null`) and preserves a residual effect, sometimes rewritten to account for the user’s original intent.

---

### A.4 Inversion property

For every conflict that supports both resolutions, the `keep_admin` outcome can be derived mechanically from `keep_mine`.

Formally:

1. Apply `keep_mine`, producing a rewritten user operation and an identity effect.
2. Move the inverse of the rewritten user operation into the effect.
3. Drop the user operation.

This property guarantees that `keep_admin` introduces no additional behavior beyond what is already expressible by `keep_mine`.

The system therefore needs only one fundamental rewrite mechanism; the second resolution is derived.
