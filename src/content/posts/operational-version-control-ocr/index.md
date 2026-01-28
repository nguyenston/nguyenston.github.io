---
title: "Operational Version Control for OCR"
published: 2026-01-27
# image: "./example.jpg"
description: Patches, Branches, and Rebase in a Manga Reader.
tags: [mokuro,ocr,version-control,systems-design]
category: Projects
draft: false
---

I’m building a manga reader where you can edit OCR while you read. The easy part is changing the text. The hard part is making those edits into a collaborative effort:

- There’s an official OCR that can be updated.
- Readers want private fixes that don’t affect others.
- Some readers want to contribute their fixes back.
- When the official OCR changes, private fixes shouldn’t quietly break.

This is a version control problem, with constraints that Git-style snapshots don’t handle well. OCR is structured, spatial data. Edits have intent (replace, delete, reorder), not just before/after states. Users expect undo, private forks, and safe reconciliation when the upstream OCR changes.

This post describes a patch-based, operational version control system designed specifically for OCR editing. Including how rebase, history navigation, conflict resolution, and history compression work under this system.

## 1. Problem and constraints

The UI is simple: render OCR text (lines/blocks with bounding boxes) as an overlay, user can make edits on the errors they see, and keep reading.

The system problem starts when OCR becomes shared state.

- There is an official (“canonical”) OCR for each volume/page.
- Readers want to fix OCR as they encounter mistakes, but those edits should be private by default.
- Some readers want to contribute fixes back to the canonical OCR.
- The canonical OCR can change later (better model, better scan, admin cleanup). When that happens, private edits shouldn’t silently drift onto the wrong lines or disappear.

This is “version control,” but it’s operational rather than snapshot-based: OCR is structured JSON (pages → blocks → lines + geometry), and we want to track editing as a sequence of atomic operations over that structure.

### 1.1 Requirements

Correctness and user-local

- Private edits must be isolated per user by default.
- When canonical OCR changes, we must either (a) adapt private edits forward, or (b) surface a conflict that the user can resolve. No silent corruption.
- Undo/redo should behave like users expect in an editor.
- History should be inspectable enough to support “what happened?” debugging.

Collaboration model

- Multiple users can edit the same volume concurrently, but not necessarily in real-time.
- The canonical OCR is controlled by an admin/maintainer; user contributions are proposals until accepted.

Data and performance

- OCR is large (many pages, many lines). We can’t treat the whole volume JSON as the unit of change.
- Rendering should be fast enough for a reader: we can’t replay thousands of edits on every page load.
- Storage should be incremental: store changes, not full copies of OCR for every user.

### 1.2 Non-goals (for this design)

- Real-time multi-cursor collaborative editing (OT/CRDT-style).
- Automatic semantic merging for arbitrary text edits; instead we do conflict resolution at the line/block level with well defined structure.
- Treating OCR as “just text.” Geometry and stable identities matter because the overlay is spatial.

## 2. Why snapshots (and Git) don’t map cleanly

Snapshot-based version control is not appropriate here because it doesn’t exploit the structured nature of OCR data, and instead pushes the burden of interpretation onto the user. That tradeoff is acceptable for developers editing source code, but not for non-technical readers correcting strict, spatial data.

OCR editing requires the system to understand *what kind of change* was made and *what object* it targeted, and then provide clean, well-scoped choices when reconciliation is required. Snapshot-based systems track only before/after states. Once edit intent is lost, reconciliation becomes a human inference problem.

### 2.1 Snapshots discard structure and intent

OCR in a reader is not flat text. It is spatial, structured data:

- pages contain blocks
- blocks contain lines
- lines have both text and geometry

Edits operate on these semantic units. A user usually means “replace the text of this line,” “remove this block,” or “fix the reading order,” not “modify arbitrary bytes in a JSON file.”

Snapshot diffs discard this structure. They record that *something* changed, but not why: whether it was a replacement, a move, or a deletion, nor which logical object the change was intended for.

At that point, the burden shifts to the user. Resolving conflicts becomes a matter of interpretation: deciding which version to keep, how to merge them, or how to manually reconcile mismatched structure. This is exactly what tools like Git ask users to do during conflict resolution. That introduces too many degrees of freedom for a non-technical user working on strictly structured data.

### 2.2 Snapshots require lots of storage

Separately from correctness and user experience, snapshot-based storage is also a poor fit for OCR.

OCR volumes are large, while most edits are small and localized. Storing full snapshots per user or per edit duplicates large amounts of unchanged data and increases storage and bandwidth costs. It also makes incremental updates more expensive than necessary.

This is a real concern, but it is not the core failure mode. Even if storage were free, snapshots would still lack the information needed to reconcile edits safely.

### 2.3 What we borrow from Git (and what we don’t)

The problem is not Git’s mental model. Branches, a canonical mainline, HEAD pointers, and rebase as “changing the past and reinterpreting the future” all apply cleanly to OCR editing.

What does not transfer is Git’s unit of change.

Git is built around snapshotting files and asking users to resolve conflicts by interpreting diffs. For OCR, the system should do that work itself by preserving structure and intent: storing edits as typed operations over structured objects, and reconciling them mechanically whenever possible.

That leads to an operational model: immutable patches, branch pointers, and rebase as a transformation of meaning rather than a replay of states.

## 3. Data model: patch tree + per-user branches

In Section 2, we committed to an operational model: edits are represented as explicit, typed operations over structured OCR data. Once that decision is made, the remaining design space narrows quickly. The system needs a way to:

- store edit operations without duplicating OCR content,
- maintain isolated contexts for each user’s private history,
- and support fast reads for the common case.

These requirements lead to two core design choices:

- a global history of edits represented as immutable **patch nodes**
- lightweight, per-user **branch records** that act as mutable pointers into that history

Together, this gives cheap branching (copy-on-write), predictable history navigation (pointer movement), and a concrete structure to support rebase and reconciliation.

### 3.1 Patch nodes: immutable edit history

Each edit produces a single patch. A patch represents one atomic operation against the OCR structure. Each patch stores:

- an `id`
- a `parentId` (the patch it was built on)
- metadata (author, timestamp, volume)
- the operation payload (replace text, remove block, reorder lines, etc.)

Patches form a tree via `parentId`. The official OCR is a distinguished path through this tree (the canonical history), and user edits appear as forks off that path.

```
Official (Admin):
P0 ───> P1 ───> P2 ───> P3 (HEAD_Admin)
        │
        └─────> U1 ───> U2 (HEAD_User)
                ▲
                │
            (ROOT_User)

```

Trees of patches can be deleted but the patches themselves cannot be rewritten. New edits always create new patches.
This single decision — immutable history — makes undo, branching, and reconciliation predictable.

### 3.2 Branches are pointers, not copies

A user does not own a copy of the OCR. They own a **branch record**: a small piece of metadata that says which patch represents their current view.

A branch record is keyed by `(volume, user)` and contains only pointers:

- `headPatchId`: where the user currently is (HEAD)
- `rootPatchId`: where the user’s private history begins
- bookkeeping fields (e.g. version counters)

No OCR content lives here.

If `rootPatchId` is null, the user is cleanly tracking the official OCR. Their HEAD simply points at a mainline patch.

### 3.3 `rootPatchId`: collapsing a tree into a linear timeline

Globally, patch history forms a tree: multiple users may fork, the official branch advances, and patches can have more than one child.

From a user’s perspective, however, history must feel linear. Undo, redo, and inspection all assume a single timeline: “what happened before” and “what happened after.”

The role of `rootPatchId` is to bridge these two views.

For a given user, `rootPatchId` explicitly marks the start of their private history. All patches descended from the `rootPatch` form a contiguous, linear segment that behaves like a traditional editor timeline:

`genesis → … → forkPoint → rootPatch → … → terminus`

Where `forkPoint` is the direct parent patch of `rootPatch`, belonging to the main branch. Everything before `rootPatch` belongs to the shared past and is treated as immutable context.


- If `rootPatchId` is null, the user has no private edits and is tracking the official timeline.
- Once the user makes their first edit, `rootPatchId` is set, and a private linear history is established.


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

Each branch tracks:

- `snapshotPatchId`: the patch the snapshot corresponds to
- `headPatchId`: the patch the branch wants to render

If these match, the snapshot can be used directly. Otherwise, patches are replayed incrementally to bring the snapshot up to date.

Snapshots improve performance, but they are never authoritative. The patch history is the source of truth.

This separation is important: correctness comes from history, speed comes from caching.

### 3.5 Invariants the system relies on

The model works because a few invariants are enforced:

- Patches are immutable once written
- If a patch is an ancestor of any HEAD pointer, it cannot be deleted
- Admin's `rootPatch` is always `genesis`; at any moment, the chain of patches from Admin's `headPatch` to `genesis` defines the main branch
- A user's `rootPatch` is always a direct child of a patch belonging to the main branch
- For any `headPatch`, undo and redo traverse a single linear chain of patches; redo is never ambiguous.

With these invariants in place, the system can safely build higher-level behaviors — undo, reset, rebase, and contribution — on top of simple pointer updates.

## 4. Patch operations: a minimal language for OCR edits

As discussed earlier, patches must preserve edit intent. That means patches should correspond to the editor actions users actually take.

Instead of storing arbitrary JSON diffs, we define a small set of typed operations that cover the common edit intents in a manga OCR overlay:

- replace text for a specific line
- add a new line/block
- remove a line/block
- reorder items (reading order fixes)

These operations are the unit that gets replayed, undone/redone, rebased, and conflict-checked.

### 4.1 The document we’re editing

The underlying OCR format is structured JSON. In this case, it follows a Mokuro-style layout:

```
MokuroData (Volume)
│
├── title?        : string
├── title_uuid?   : string (UUID)
├── volume?       : number | string
├── patch_id?      : string
│
└── pages         : MokuroPage[]
    │
    ├── img_path   : string
    ├── img_width  : number
    ├── img_height : number
    │
    └── blocks     : MokuroBlock[]
        │
        ├── box          : number[] (top-left and bottom-right corners)
        ├── vertical     : boolean
        ├── font_size?   : number
        ├── lines        : string[]
        └── lines_coords : Quad[]   (parallel to lines; each Quad = 4 corners)
```

Edits never operate on the document as a flat blob. They always target a specific page, block, or line, and often need to preserve spatial metadata alongside text.
Two details matter for version control:

- Lines are represented as paired arrays (`lines[]` and `lines_coords[]`), so text and geometry must stay in sync.
- Ordering is meaningful: block order and line order encode reading order, not just storage position.

Patch operations are defined against this structure rather than against raw JSON.

### 4.2 Typed operations

Each patch represents a single, typed edit operation. The type captures *what kind of change* the user intended to make.

The core operations are:

- `replace`: update a leaf value (e.g. line text or geometry)
- `add`: insert a structural unit (line or block)
- `remove`: delete a structural unit
- `reorder`: change the order of siblings within a container
- `genesis`: introduce the initial document state

These operations are intentionally coarse. They align with editor actions rather than low-level mutations, which makes them easier to reason about during replay, rebase, and conflict handling.

### 4.3 Fine values vs structural values

Not all edits operate at the same level.

Some edits change a single value in place, such as updating the text of a line. Others add or remove entire structural units, such as inserting a new line or deleting a block.

To reflect this, patch values are split into two categories:

- **Fine values**: leaf-level fields that can be replaced directly (strings, numbers, geometry).
- **Structural values**: grouped units that must move together (a line’s text and coordinates, or an entire block).

Structural values exist to prevent partial updates that would leave the document in an inconsistent state. For example, removing a line must remove both its text and its geometry as one operation.

### 4.4 Addressing targets with paths

Each patch targets its edit using a path. Paths are index-based and reflect the document structure:

- `/pages/{p}/blocks/{b}`
- `/pages/{p}/blocks/{b}/lines/{l}`
- `/pages/{p}/blocks/{b}/lines/{l}/text`
- `/pages/{p}/blocks/{b}/lines/{l}/coords`

Paths are intentionally constrained. Only paths that correspond to valid editor actions are allowed.

Two conventions are enforced:

- Indices may equal `array.length` to indicate insertion at the end.
- Structural edits never target raw parallel arrays (e.g. `lines_coords` directly). Geometry edits go through the line abstraction.

These constraints eliminate entire classes of invalid or ambiguous patches.

### 4.5 Old values and validation

Destructive operations (`replace` and `remove`) carry an `old_value`.

This serves two purposes:

- It makes patches invertible, which is required for undo.
- It provides a cheap validation check during replay and rebase.

If the current document state does not match the expected `old_value`, the patch cannot be applied. That mismatch is an indicator of data corruption.

### 4.6 Why not use RFC 6902 (JSON Patch)

At a glance, the patch language here resembles RFC 6902 (JSON Patch): it uses `add`, `remove`, and `replace` operations targeted by paths.

The difference is not expressive power, but shape. Generic JSON Patch treats all changes as equivalent tree mutations. For OCR editing, that erases important distinctions about *what kind of edit* was intended.

A concrete example is reading order. In manga OCR, fixing reading order is common and intentional. Encoding this as a sequence of deletes and inserts obscures that intent and makes it difficult to reason about during rebase.

Instead, reordering is expressed explicitly as a permutation within a container. This preserves the intent of the edit and allows reorder operations to be transformed mechanically by composing permutations, rather than inferring meaning from index shifts.

More broadly, the patch language is tailored to the OCR domain:

- operations correspond directly to editor actions
- paths are limited to meaningful structural targets
- destructive edits carry `old_value` for validation and inversion

RFC 6902 remains a good general-purpose format. For structured OCR data that must survive rebase and reinterpretation, a domain-shaped operation set makes intent explicit and reconciliation tractable.

## 5. Workflows: writing patches and moving pointers

With immutable patch history in place, most workflows reduce to the same two actions:

- write a new patch, or
- move a branch pointer (and potentially cleanup dangling patches).

History itself is never mutated. This keeps behavior predictable even as multiple users and the admin interact with the same OCR.

### 5.1 Fork-on-write

A user starts in a clean state: they are effectively viewing the official OCR.

- `rootPatchId = null` (no private fork)
- `headPatchId = officialHead` (your HEAD points at the current official patch)

  ```
  Official (Admin):
  P0 ───> P1 ───> P2 ───> P3 ───> P4 (HEAD_Admin)
                  ▲
                  │
               (HEAD_A)
               (ROOT_A: Ø)
  ```

On the first edit, we fork by creating the first private patch:

- create patch `U1` with `parentId = officialHead`
- set `rootPatchId = U1` (this marks where the private history begins)
- set `headPatchId = U1`

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
- write a new patch with `parentId = headPatch`
- advance `headPatch` to the new patch

If the user had undone edits and applies a new patch, any abandoned redo future is normally discarded. This mirrors standard editor behavior.

There is one important exception. If the user’s `headPatch` is currently pointing into the main branch (i.e. the user undid past `rootPatch`), discarding the redo future would violate Invariant 2, which requires that any patch that is an ancestor of a HEAD pointer must remain alive.

In this case, instead of deleting the abandoned future, the system performs a fork-on-write:

- the new patch is created as a child of the current `headPatch`
- prune at `rootPatch`
- the user’s `rootPatch` is then set to the new patch

From the user’s perspective, this still behaves like “edit after undo.” Internally, it preserves the invariants by turning the edit into the start of a new private branch rather than rewriting canonical history.

### 5.3 Undo

Undo moves the branch cursor backward:

- set `headPatch` to its parent
- no patches are modified or deleted

Undo never mutates history; it only changes where the branch points.

### 5.4 Admin undo: preserving invariants with branch drag

User undo is cheap because it only moves that user’s `headPatch`.

Admin undo is trickier because it can potentially break one of the system’s invariants. Recall that the main branch is defined as the chain of patches from the admin `headPatch` back to `genesis` (Invariant 3). If the admin `headPatch` moves backward past a user’s `rootPatch`, that user’s private history is no longer rooted at a main-branch patch, violating Invariant 4.

The branch drag mechanism is employ as a way to preserve these invariants, while still giving the admin limited freedom to undo mistakes:

- If no branch depends on the current admin HEAD, the admin can move `headPatch` back (and the reverted patch may be eligible for deletion).
- If exactly one branch would become invalid under Invariant 4, we still undo — but we *drag* that branch’s `rootPatch` so it remains a direct child of the (new) main branch.
- If more than one branch would become invalid, we refuse the undo: the history has solidified.

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

### 5.5 Redo (user branches only — admin cannot redo)

From a given HEAD, there might be multiple children:

- the official continuation
- a foreign user’s fork root
- your own fork root (if you undid back to the fork point)

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

When user B hits redo, should the pointer move to `A1` or `P3`? In order to preserve invariant 5 (redo must never be ambiguous), the following decision tree is followed:

1. If you are sitting at the fork point and about to redo into *your own* private history:

    - if `rootPatch.parentId == currentHeadId`, redo goes to `rootPatch`

2. Otherwise, if the current patch has an explicit official successor:

    - follow `currentPatch.nextPatch` (the mainline)

3. Otherwise, if there is only one child in the `parentId` tree:

    - follow that only child

4. If there are multiple children and none are explicitly disambiguated:

    - refuse redo
    - This violates invariant and should be treated as a bug or data corruption, not a normal user scenario.

This is the real reason `nextPatchId` exists: it is a fast path for enforcing the definition of the main branch.
Recall that the main branch is defined structurally as the ancestor chain from the admin `headPatch` back to `genesis` (Invariant 3). In principle, determining the official continuation from a patch could always be done by walking ancestry from the admin head.
`nextPatchId` simply caches this information in the forward direction. It marks which child belongs to the canonical spine so redo can follow the main branch directly, without scanning children or recomputing ancestry.

### 5.6 Reset (discard private edits)

Reset returns the user to “tracking official.”

- prune at `rootPatch`
- set `rootPatchId = null`
- set `headPatchId = officialHead`
- bump `version`

### 5.7 Officialize (promote a private branch to canonical)

Officialization is an admin action: take a user’s patch chain and make it the official OCR.

The safe case is a fast-forward:

- if `userHead` is a descendant of `officialHead`
- then set `officialHead = userHead`
- and update the official `nextPatchId` pointers along that path

After that, the user branch can be reset to clean.

If the user head is not a descendant (i.e., official moved ahead independently), then “officialize” becomes a rebase/merge problem. In this design, that case is handled explicitly via the rebase workflow instead of silently forcing it.

## 6. Rebase: reinterpreting edits under a changed past

Rebase is needed when a user’s private history was written against a version of the document that is no longer fresh.

Because patches are stored as operations rather than snapshots, rebase does not merge states. It reinterprets each operation under a new base document.

The goal of rebase is simple: restore the invariant that every patch is applied to the document state it expects.

### 6.1 When rebase is required

A rebase is required when:

- the admin branch has advanced, and
- a user’s `rootPatch` is no longer a direct child of the current main branch.

This can happen when:

- the admin accepts other contributions,
- the admin perform edits themselves,
- or a user resumes work after being behind the official OCR.

Until rebase completes, the user’s private patches are no longer guaranteed to apply cleanly.

### 6.2 Rebase as operation retargeting

Rebase is needed because moving the base of a branch changes the context that the branch was built upon.

Each private patch was originally authored against a specific document state. When the canonical history changes, that state no longer exists verbatim. Rebase exists to reinterpret each patch under the new context, without guessing or merging snapshots.

To make this precise, the system treats rebase as **effect propagation**.

The change from the old base to the new base induces an *effect* on the document structure: lines may move, blocks may be reordered, or elements may disappear. This effect represents how the context has shifted upstream.

Rebase walks the user’s branch forward along the main branch, one patch at a time. This generates an effect, which is propagated along the branch:

- **Mutating the patch** is reinterpretation: adjusting the patch so it still expresses the same user intent under the new context.
- **Mutating the effect** is accumulation: updating the context delta to include the contribution of this patch, so downstream patches see the correct document state.

Rebase is complete when the user’s rebased history has been fully reattached to the current admin HEAD.

Operationally, rebase does not mutate any existing patch. Instead, it generates a new sequence of patches that represent the rebased edits, applied on top of the admin HEAD. Once this new sequence is created:

- the old private branch is pruned if it is no longer referenced,
- the user’s `rootPatch` and `headPatch` are updated to point to the newly generated patches.

### 6.3 Conflict detection

A conflict occurs when a patch’s intent can no longer be interpreted unambiguously.

Examples include:

- the target line no longer exists,
- the expected `old_value` does not match,
- a reorder refers to elements that were deleted upstream.

In these cases, the system pauses. The patch is marked as conflicted and requires user input.

### 6.4 Why this works

Rebase is possible because patches preserve intent.

- Operations are typed.
- Targets refer to semantic objects.
- Destructive edits are checkable.
- Reorder is explicit.

These properties make it possible to mechanically reinterpret edits under a changed past. Snapshot-based diffs lack this information and must instead ask the user to infer intent manually.

### 6.5 Complexity and termination

Rebase is deliberately structured as a linear process over two dimensions: upstream history and private edits.

Let $B$ be the number of patches between the user’s original base and the current admin HEAD, and let $A$ be the number of private patches to rebase.

Each upstream patch induces an effect on the document structure. That effect must be propagated through each downstream patch to reinterpret it under the new context. As a result, rebase work is bounded by: $\mathcal{O}(AB)$.

This reflects the actual cost of intent preservation: every private edit must be reconsidered under every upstream change that occurred since it was authored.

Termination is guaranteed. Both $A$ and $B$ are finite, and each propagation step produces a definitive outcome. Rebase is therefore a finite double loop, not an open-ended negotiation or search.

## 7. Conflict resolution

Most interactions between patches can be handled mechanically.

During replay or rebase, upstream edits induce effects that shift indices, permute order, or change content. As long as a user patch can be reinterpreted under those effects without ambiguity, it is retargeted and applied automatically.

A conflict occurs only when this reinterpretation becomes ill-defined.

In other words: conflicts mark the boundary where intent can no longer be preserved mechanically.

Typical conflict cases include:

- editing content inside a subtree that was deleted upstream,
- both sides modifying the same field in incompatible ways,
- structural edits that invalidate assumptions made by later patches.

When this happens, the system does not guess.

### 7.1 Two resolution semantics

All conflicts are resolved by choosing one of two *consistent interpretations of history*:

**`keep_admin`**

- user patch is removed, the effect changes to compensate for the disappearance of the patch

**`keep_mine`**

- upstream effect is absorbed the user’s patches changes to behave as if the shifted context had always been the case.

The full taxonomy of conflicts, intersection types, and rewrite rules is specified in Appendix.

### 7.2 Conflict resolution as history reinterpretation

Conflict resolution is a choice about how to interpret user intent under a changed context.

Under `keep_mine`, the system assumes that even if upstream edits had already been present, the user would have made an edit that results in the same document state anyway. The change is treated as intentional and preserved by rewriting history so the user’s patches remain meaningful under the new context.

Under `keep_admin`, the system assumes the opposite: given the updated context, the user would not have made this edit. The conflicting patch is therefore discarded or rewritten away, and future edits are interpreted as if the change never happened.

In both cases, the rendered document state is consistent. What differs is the counterfactual assumption about user intent, and therefore which history future edits are anchored to.

## 8. Making this fast: snapshots, replay, and compression

Reconciliation logic is only useful if it performs well enough to be used interactively.

At runtime, the system must be able to answer one question cheaply:

> What is the current document state for this branch?

The performance story has three mechanisms:

- snapshots
- patch replay
- patch compression

### 8.1 Snapshots as cached state

A snapshot is a cached materialization of the document at a specific patch.

Each branch tracks:

- `snapshotPatchId`: which patch the snapshot corresponds to
- `headPatchId`: which patch the branch currently wants

Contract:

- if `snapshotPatchId == headPatchId`, load and render
- otherwise, load the snapshot and replay only the missing patch ancestry

Snapshots improve performance, but never define correctness.

### 8.2 Replay as the fallback

If a snapshot is missing or out of date, the system replays patches to reach the desired state:

- find the patch ancestry between `snapshotPatchId` and `headPatchId`
- apply patches (or inverses) in order
- advance `snapshotPatchId`

Undo, redo, and branch-pointer rewrites all funnel into the same mechanism: change pointers, then replay to materialize the corresponding state.

To keep replay safe without diffing giant JSON blobs, patch application relies on cheap validation:

- optimistic locking via branch `version`
- `old_value` checks for destructive/content edits

### 8.3 Compression: removing unnecessary history

Over time, patch histories grow. Long histories increase replay cost and make rebases more expensive.

Compression reduces history length without changing semantics, and it’s expressed in the same reconciliation language as rebase.

Instead of asking:

- “How does the future adapt if a patch is added to the past?”

Compression asks the counterfactual:

- “How does the future adapt if a patch is removed from the past?”

A simple way to test whether a patch is necessary:

1. Temporarily remove a candidate patch from the private chain.
2. Treat its removal as a change to history (an effect).
3. Use the same rebase machinery (under keep\_mine semantics) to rewrite later patches so the rendered state stays identical.
4. If the future can be rewritten to fully compensate, drop the patch. If not, keep it.

### 8.4 Summary

Collaboration is treated as a reconciliation problem:

- edits may be independent or interfering
- history may change after work has already been done
- intent must be preserved explicitly

Rebase, conflict resolution, undo, and compression are all variations of the same idea:

- adjust history
- rewrite future edits to match the new assumptions

This keeps collaboration predictable, explicit, and scalable.

## 9. Conclusion

Collaborative OCR editing is a reconciliation problem.

Edits may be independent or interfering. History may change after work has already been done. Intent must be preserved explicitly.

OCR in a reader is not a flat text file. It is a structured, spatial document, where edits have **semantic meaning** (replace vs delete vs reorder), not just a before/after diff. That is why this system is operational rather than snapshot-based.

The core design choices follow directly:

- represent edits as a small typed patch language over the OCR structure
- store history as an immutable patch tree
- represent branches as pointers into that tree, with `rootPatchId` marking the boundary between official history and private work

With that foundation, the workflows become consistent mechanics:

- undo and redo are pointer movement (with `nextPatchId` making the official child explicit)
- admin undo is conservative, using branch drag to avoid breaking downstream readers
- rebase retargets edits when history changes, surfacing conflicts when intent becomes ambiguous
- snapshots, replay, and compression make this fast enough to use interactively

Rebase, conflict resolution, undo, and compression are all variations of the same idea:

- adjust history
- rewrite future edits to match the new assumptions

What was challenging was not any single feature, but keeping the invariants straight across all of them:

- the resolution table itself: an exhaustive, case-by-case state machine covering how every operation type interacts with every upstream change, without violating invariants or introducing ambiguous redo paths
- redo disambiguation
- canonical stability
- safe pruning of abandoned futures
- designing snapshots procedures so as to accelerate the system without reintroducing silent drift or state-based semantics

What I’m proud of are the insights that made these invariants implementable:

- `rootPatch` as a crisp fork boundary, enforcing a linear timeline for each user
- rebase as **causal effect propagation**: upstream patches become effects that change the context later edits are interpreted under
- branch drag, which relaxes admin undo without destabilizing downstream branches
- compression without extra behavior, by treating “remove a patch from history” as a counterfactual change and reusing the same keep\_mine rewrite machinery

The result is not a general-purpose version control system, but one shaped by the structure and semantics of OCR data.

## Appendix: Rebase Semantics

This appendix is the “executable spec” for Section 6/7.

### A.0 Effect construction (Admin → Effect)

Each admin patch is converted into exactly one effect:

- **Add** at `/array/i`
  - `shift_up(path=/array, index=i, newValue)`
- **Remove** at `/array/i`
  - `shift_down(path=/array, index=i, deletedValue)`
- **Reorder** at `/array` with permutation `P`
  - `permute(path=/array, permutation=P⁻¹)`
- **Replace** at `/path`
  - `content(path, oldValue, newValue)`
- Other
  - `identity`

Reorder effects store the inverse permutation (`P⁻¹`) so composition is efficient and directionally consistent.

---

### A.1 Intersection Classification

| Type                        | Meaning                                             | What Transforms |
| --------------------------- | --------------------------------------------------- | --------------- |
| `no_hit`                    | No overlap between user patch and effect            | None            |
| `collateral_ancestor_hit`   | Structural effect on array, user patch inside array | User patch path |
| `collateral_descendant_hit` | User structural patch, effect inside array          | Effect path     |
| `sibling_hit`               | Both structural, same array level                   | Both            |
| `direct_hit`                | Exact path match                                    | Conflict        |
| `ancestor_hit`              | User patch inside affected subtree                  | Conflict        |
| `descendant_hit`            | Effect inside user patch subtree                    | Conflict        |

---

### A.2 Deterministic Structural Transforms (No Conflict)

#### collateral\_ancestor\_hit

| effect.type  | user.op | Handling                           |
| ------------ | ------- | ---------------------------------- |
| `shift_up`   | any     | user index ≥ effect.index → +1     |
| `shift_down` | any     | user index > effect.index → −1     |
| `permute`    | any     | map user index through permutation |

#### collateral\_descendant\_hit

| effect.type | user.op   | Handling                             |
| ----------- | --------- | ------------------------------------ |
| any         | `add`     | effect index ≥ add.index → +1        |
| any         | `remove`  | effect index > remove.index → −1     |
| any         | `reorder` | map effect index through permutation |

#### sibling\_hit

| effect.type  | user.op   | Handling                                |
| ------------ | --------- | --------------------------------------- |
| `shift_up`   | `add`     | shift add index, adjust effect index    |
| `shift_up`   | `remove`  | shift remove index, adjust effect index |
| `shift_up`   | `reorder` | expand permutation, map effect index    |
| `shift_down` | `add`     | shift add index, adjust effect index    |
| `shift_down` | `remove`  | shift remove index, adjust effect index |
| `shift_down` | `reorder` | map effect index, shrink permutation    |
| `permute`    | `add`     | expand permutation, map add index       |
| `permute`    | `remove`  | map remove index, shrink permutation    |

---

### A.3 Conflict Resolution Matrix

| Intersection    | effect.type  | user.op   | Conflict              | Auto | keep\_admin                               | keep\_mine                       |
| --------------- | ------------ | --------- | --------------------- | ---- | ----------------------------------------- | -------------------------------- |
| direct\_hit     | `shift_down` | `add`     | `shift_down_into_add` | ✓    | keep patch, bump effect index             | —                                |
| direct\_hit     | `shift_down` | `remove`  | `double_delete`       | ✓    | discard patch, absorb effect              | —                                |
| direct\_hit     | `permute`    | `reorder` | `reorder_collision`   | ✗    | discard user reorder, compose into effect | rewrite reorder as A⁻¹∘U, absorb |
| direct\_hit     | `content`    | `replace` | `content_conflict`    | ✗    | discard user replace                      | update old\_value, absorb        |
| ancestor\_hit   | `shift_down` | any       | `dead_zone`           | ✗    | discard user patch                        | resurrect deleted value, absorb  |
| descendant\_hit | any          | `remove`  | `reverse_dead_zone`   | ✗    | discard delete, effect becomes shift_up   | update old\_value, absorb        |
| descendant\_hit | any          | `add`     | `effect_shift`        | ✓    | shift effect path                         | —                                |
| descendant\_hit | any          | `reorder` | `effect_shift`        | ✓    | permute effect path                       | —                                |

**Invariant:**\
`keep_mine` typically absorbs the effect (effect → identity), while `keep_admin` typically preserves the effect, except where a compensating structural effect is required.
