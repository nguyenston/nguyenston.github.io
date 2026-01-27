---
title: "Operational Version Control for OCR"
published: 2026-01-27
# image: "./example.jpg"
description: Patches, Branches, and Rebase in a Manga Reader.
tags: [mokuro,css]
category: Projects
draft: false
---

I’m building a manga reader where you can edit OCR while you read. The easy part is changing the text. The hard part is making those edits into a collaborative effort:

- There’s an official OCR that can be updated.
- Readers want private fixes that don’t affect others.
- Some readers want to contribute their fixes back.
- When the official OCR changes, private fixes shouldn’t quietly break.

So I designed a version control layer inspired by Git, but not quite. It’s patch-based, structured, and designed around the operations OCR editing actually needs.

## 1. Problem and constraints

The UI is simple: render OCR text (lines/blocks with bounding boxes) as an overlay, user can make edits on the errors they see, and keep reading.

The system problem starts when OCR becomes shared state.

- There is an official (“canonical”) OCR for each volume/page.
- Readers want to fix OCR as they encounter mistakes, but those edits should be private by default.
- Some readers want to contribute fixes back to the canonical OCR.
- The canonical OCR can change later (better model, better scan, admin cleanup). When that happens, private edits shouldn’t silently drift onto the wrong lines or disappear.

This is “version control,” but it’s operational rather than snapshot-based: OCR is structured JSON (pages → blocks → lines + geometry), and we want to track editing as a sequence of atomic operations over that structure.

### 1.1 Requirements

Correctness and user trust

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

At first glance, OCR looks like a file: it’s just JSON, so we could store “latest OCR.json” and keep old versions as snapshots.

That breaks down once you add *private branches* and *upstream updates*.

### 2.1 OCR isn’t a flat text file

OCR in a reader is spatial data:

- pages → blocks → lines
- each line has text *and* geometry (bounding boxes, reading order)

A line edit is not “replace bytes in a file.” It’s usually “replace the text for this specific line object,” sometimes plus structural edits like splitting/merging lines or reordering blocks.

Snapshot diffs don’t understand those operations. They can tell you “the JSON changed,” but not *what intent* the change had (replace vs move vs delete), which is exactly what you need to re-apply edits safely.

### 2.2 Snapshots explode in storage and bandwidth

If you store full OCR snapshots per user (or per edit), you pay O(size of volume) for tiny changes.

- OCR volumes are large.
- Most edits are small.
- Users can generate many edits over time.

You end up copying the same baseline data repeatedly, and you still haven’t solved merging.

### 2.3 Snapshot-based merge has the wrong conflict model

When canonical OCR updates, we need to answer: “does this user edit still apply, and if so, where?”

If user edits are stored as full states, the system lacks a stable handle on *which objects* were edited. Even simple upstream changes like:

- inserting a new block
- reordering lines
- deleting a line that a user edited

can shift indices and cause edits to drift or apply to the wrong target unless you do heavyweight matching.

This is the key trust failure: **a system that silently misapplies edits is worse than a system that refuses and asks for a decision**.

### 2.4 Undo/redo wants operations, not states

Readers expect undo/redo to be local and predictable.

With snapshots, you can emulate undo by restoring old states, but:

- you don’t have atomic intent (“this was a reorder” vs “many unrelated JSON edits”)
- you can’t easily drop redo history when the user makes a new edit
- you can’t attribute edits cleanly to “mine” vs “upstream”

Once you model edits as atomic patches, undo/redo becomes “move HEAD,” which is simple and robust.

### 2.5 What we borrow from Git (and what we don’t)

We borrow the *mental model*:

- a canonical branch (“official OCR”)
- per-user branches (“my private fixes”)
- HEAD pointers
- rebase as “apply my changes on top of the new official base”

But we don’t borrow Git’s implementation:

- Git is file/snapshot oriented.
- Our OCR data is structured and operation-heavy.
- We store edits as a sequence of typed patches over structured objects, and we implement rebase as a transform over those patch operations.

## 3. Data model: patch tree + per-user branches

The core idea is the same trick Git uses: **history is immutable, and “a branch” is just a pointer into that history**.

Instead of storing “the latest OCR.json” for every user, we store:

- a global history of edits as **patch nodes** (immutable)
- per-user **branch records** that point at a particular patch (mutable pointers)

This gives cheap branching (copy-on-write), predictable undo/redo (move a pointer), and a concrete object to rebase.

### 3.1 Patch nodes: immutable edit history

A patch is a single typed operation against the structured OCR document.

Each patch stores:

- `id` (DB id / UUID)
- `parentId` (the previous patch it was applied on top of)
- metadata (author, timestamp, volume)
- the operation payload (e.g., replace line text, reorder blocks)

Patches form a tree via `parentId`:

- the official OCR is a distinguished path in the tree (“mainline”)
- a user’s private edits are a fork off an official ancestor

A tiny picture:

```
Official (Admin):
P0 ───> P1 ───> P2 ───> P3 (HEAD_Admin)
        │
        └─────> U1 ───> U2 (HEAD_User)
                ▲
                │
            (ROOT_User)

```

Where `P3` is the current official head, and `U2` is one user’s head.

Note: Git uses cryptographic hash pointers (content-addressed). Here, `id` can just be a database identifier. The *pointer model* is the same; the integrity mechanism is different.

### 3.2 Branch records: per-user pointers into history

A branch record is keyed by (volume, user). It stores no OCR content — only where you are in history and how to render quickly.

Typical fields:

- `headPatchId`: the patch that represents the current state (HEAD)
- `rootPatchId`: the first private patch on this branch
  - null means “clean”: no private edits, effectively tracking official
- `snapshotPatchId`: which patch the cached snapshot corresponds to
- `version`: optimistic-lock counter to prevent races (e.g., two edits arriving at once)

Why `rootPatchId` matters: it draws a bright line between “official history” and “my private history.”

- `rootPatchId = null` → no private history exists; you’re tracking official
- `rootPatchId != null` → your private history is exactly the segment from `rootPatchId` to `headPatchId`

Here’s what that looks like with two users (A tracks official, B forks):

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

The important property is that you can look at `rootPatchId` and immediately know whether the user has a private fork, and exactly where it begins.

That single pointer unlocks workflows:

- Reset: delete patches starting at `rootPatchId` (cascade), set `rootPatchId = null`, set `headPatchId = officialHead`
- Identify contributions: the user’s fork is exactly the segment starting at `rootPatchId`

### 3.3 Snapshot cache: fast reads, authoritative DB

Rendering needs a materialized OCR JSON snapshot. Replaying patches from genesis on every load would be too slow.

So each branch maintains a cached snapshot file and tracks what it corresponds to:

- snapshot is fresh if `snapshotPatchId == headPatchId`
- otherwise we rebuild by replaying patches until the snapshot matches HEAD

### 3.4 Invariants we rely on

- Patches are immutable once written.
- Branch state is just pointers; moving HEAD never mutates history.
- The official head lies on the `nextPatchId` chain.
- We only delete unreachable private forks (no shared ancestors are ever deleted).

With the history structure in place, the next step is defining the patch operation language.

## 4. Patch operations: the minimal language for OCR edits

The patch tree is only useful if patches are meaningful. For OCR, “meaningful” means: patches should correspond to the editor actions users actually take.

Instead of storing arbitrary JSON diffs, we define a small set of typed operations that cover the common edit intents in a manga OCR overlay:

- replace text for a specific line
- add a new line/block
- remove a line/block
- reorder items (reading order fixes)

These operations are the unit that gets replayed, undone/redone, rebased, and conflict-checked.

### 4.1 The document we’re editing

In my case the underlying OCR format is Mokuro-style JSON. The important bit is that it’s a nested structure with geometry:

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

Two details matter for version control:

- **Lines are “split arrays”**: `lines[i]` and `lines_coords[i]` are a paired unit.
- The snapshot can carry a `patch_id` field, which is exactly what we use to say: “this rendered OCR corresponds to patch X.”

Each line carries both:

- the recognized text
- geometry (bounding box / polygon) and ordering metadata

That geometry matters: the overlay is spatial, so “which line” cannot be inferred reliably from text content alone.

### 4.2 PatchOperation: the actual types

In my implementation, a patch is a JSON payload with a small tagged union. The key thing is that every patch is:

- **typed** (`op: 'replace' | 'add' | 'remove' | 'reorder' | 'genesis'`)
- **addressed** by a `path: string`
- **invertible / checkable** via `old_value` on destructive edits

Two supporting type choices matter a lot.

#### 4.2.1 Fine vs coarse values

I split patch values into two categories:

- FineValue: leaf-level scalars that are safe to replace in place
  - `string | boolean | number | Rect | Quad`
- CoarseValue: structural units that should move together
  - `UnifiedLine` (text + coords)
  - `UnifiedBlock` (box/flags + lines[])

This exists because Mokuro’s native format uses **split arrays** (`lines[]` and `lines_coords[]`). If you treat those as independent edit targets, it’s easy to corrupt the pairing. Coarse values let “a line” be atomic even if storage is split.

#### 4.2.2 Unified views for atomic edits

A UnifiedLine merges the parallel arrays into one logical object:

- `{ text, coords }`

A UnifiedBlock is the same idea for the block:

- `{ box, vertical, font_size?, lines: UnifiedLine[] }`

That means add/remove operations can talk about “insert this line” or “delete this block” without needing the caller to manually keep the split arrays consistent.

### 4.3 The operation union

Operationally, patches look like:

- `genesis`: introduces the starting point for a volume

  - `{ op: 'genesis'; path: string }`

- `replace`: change a fine-grained field (typically line text, or a geometry field)

  - `{ op: 'replace'; path: string; value: FineValue; old_value: FineValue }`

- `add`: insert a structural unit (a line or a block)

  - `{ op: 'add'; path: string; value: CoarseValue }`

- `remove`: delete a structural unit (a line or a block)

  - `{ op: 'remove'; path: string; old_value: CoarseValue }`

- `reorder`: reorder siblings inside a container

  - `{ op: 'reorder'; path: string; new_order: number[] }`

Two practical notes:

- `old_value` is doing real work: it’s what makes destructive operations invertible (for undo) and what gives you a cheap validation hook during rebase/conflict detection (“is the thing I’m about to edit still what I edited?”).
- `reorder` uses an explicit permutation array. This is much easier to transform/rebase than a pile of index-based replaces.

### 4.4 Targeting: the path specification (index-addressed, but constrained)

Every patch points at its target via a `path: string`. This is not an arbitrary JSON Pointer over the entire snapshot; it’s a **constrained path grammar** for the edit operations we support.

At a high level, paths always start from `/pages/{p}` and then either address blocks or lines:

- Blocks live at: `/pages/{p}/blocks/{b}`
- Lines live at:  `/pages/{p}/blocks/{b}/lines/{l}`

From there, the leaf segments determine what kind of value is legal.

#### 4.4.1 Block paths

- Add/remove a block:
  - `/pages/{p}/blocks/{b}` (value = `UnifiedBlock` for add; `old_value` for remove)
- Reorder blocks:
  - `/pages/{p}/blocks` (requires `new_order`)
- Replace block fields:
  - `/pages/{p}/blocks/{b}/box` (`Rect`)
  - `/pages/{p}/blocks/{b}/vertical` (`boolean`)
  - `/pages/{p}/blocks/{b}/font_size` (`number`)

#### 4.4.2 Line paths

- Add/remove a line:
  - `/pages/{p}/blocks/{b}/lines/{l}` (value = `UnifiedLine` for add; `old_value` for remove)
- Reorder lines:
  - `/pages/{p}/blocks/{b}/lines` (requires `new_order`)
- Replace line fields:
  - `/pages/{p}/blocks/{b}/lines/{l}/text` (`string`)
  - `/pages/{p}/blocks/{b}/lines/{l}/coords` (`Quad`)

#### 4.4.3 Two rules that prevent footguns

1. **Append convention**

To append, `{b}` or `{l}` may equal `array.length`. That makes “add at end” a first-class operation without needing a separate opcode.

2. **No direct writes to** **lines\_coords**

Mokuro stores line text and geometry as parallel arrays: `lines[i]` and `lines_coords[i]`. Directly patching `lines_coords` would make it too easy to desync them.

So geometry edits must go through `/lines/{l}/coords`, and structural edits (`add/remove/reorder`) operate on the unified `{ text, coords }` representation.

#### 4.4.4 Why index paths are still workable (and why we didn’t add IDs)

The obvious alternative to index-based paths is to give every block/line a stable ID and patch by ID.

In practice, Mokuro’s native format doesn’t include IDs — it’s arrays all the way down. Introducing IDs would mean also introducing an **ID assignment rule** that is stable across time.

That’s harder than it sounds:

- If IDs are generated once and stored, you’ve effectively created a new “extended Mokuro” format that must be migrated and kept in sync.
- If IDs are regenerated from raw data (text/geometry), you need a deterministic scheme that reliably gives the *same* ID to the “same” line across OCR reruns and admin edits. Small upstream changes (splits/merges, geometry tweaks, reorder fixes) can make identity ambiguous.

So the design stays closer to the source format: `path` uses indices, and we preserve intent by **transforming paths through structural edits**:

- `add/remove` induces shift effects (indices move up/down)
- `reorder` induces a permutation effect

Rebase and patch compression both reuse these transforms so a later patch can keep pointing at the intended element even after upstream inserts/removals/reorders.

### 4.5 Why not “generic JSON Patch”?

The patch language here is actually *very close* to RFC 6902 (JSON Patch): we have `add`, `remove`, and `replace`, and we target with a pointer-like `path`.

The differences are about **constraints and semantics**, not the verbs:

- **Constrained path grammar.** RFC 6902 allows arbitrary JSON Pointer paths; here we only allow paths that make sense for Mokuro OCR (pages/blocks/lines, plus specific leaf fields).
- **Structured payloads.** `add/remove` operate on `UnifiedLine` / `UnifiedBlock` so we can’t desync Mokuro’s split arrays.
- **Invertibility and validation.** We carry `old_value` on destructive edits so undo is well-defined and rebase can cheaply detect “this target changed upstream.”
- **First-class reorder.** RFC 6902 doesn’t include `reorder`; we add an explicit permutation operation because reading order is a primary edit in manga OCR and it’s something we want to transform during rebase.

So the point isn’t “RFC 6902 is wrong.” It’s that we’re using an RFC-6902-shaped core, then narrowing it to a domain-specific patch DSL that supports undo/redo, rebase transforms, and conflict surfacing at the right granularity.

## 5. Workflows: fork-on-write, undo/redo, reset, and officialize

This section is the “so what do we do with all those pointers?” part.

As described in Section 3, the database holds an immutable patch history, and each user has a branch record that stores pointers like `headPatchId` (HEAD) and `rootPatchId` (start of the private fork).

The theme here is consistent: **we don’t mutate history**. We write new patches and move branch pointers.

### 5.1 Fork-on-write (private by default)

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



On the first edit, we “fork” by creating the first private patch:

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

### 5.2 Creating an edit (write a patch + advance HEAD)

Every editor action produces exactly one patch operation.

A typical edit request:

- validate branch version (optimistic lock)
- create `Patch(parentId = headPatchId, operation = ...)`
- update branch: `headPatchId = newPatchId`, `version += 1`

If the user had undone edits (i.e., HEAD is not at the tip of their chain) and then makes a new edit, we drop redo history (standard editor behavior):

- any patches that were only reachable via the abandoned redo path become unreachable
- delete them (cascade) so history stays clean

### 5.3 Undo (move HEAD backward)

Undo is “move HEAD to parent.”

- load current `headPatchId`
- set `headPatchId = parentId`
- bump branch `version`

No patch is mutated. Undo is a pointer move.

### 5.4 Admin undo is different: branch drag (making canonical less fickle)

User undo is cheap because it only affects that user’s branch pointer.

Admin undo is different because the admin branch is the canonical reference that other branches hang off of. Rewriting canonical history too freely would be a trust failure: users can be reading on top of “official,” and their branch ancestry relies on that official spine.

So the admin undo rule is conservative:

- If nobody depends on the current admin HEAD, admin can move HEAD back (and in the ideal case, delete the reverted patch).
- If exactly one branch depends on it, we can still undo — but we *drag* the root pointer of that user’s private history back with the admin HEAD so their state remains valid.
- If more than one branch depends on it, we refuse the undo: history has “solidified.”

Another way to explain this is that **the patch being undone is “relinquished” from the official branch, but kept alive by making it the dependent user’s private root.**

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

Redo is where “a tree is not a list” shows up.

From a given HEAD, there might be multiple children:

- the official continuation
- a foreign user’s fork
- your own fork root (if you undid back to the fork point)
- other odd children (abandoned redo chains)

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

When user B hits redo, should the pointer move to `A1` or `P3`? So redo needs a deterministic selection rule. The priority order used here is:

1. If you are sitting at the fork point and about to redo into *your own* private history:

    - if `rootPatch.parentId == currentHeadId`, redo goes to `rootPatch`

2. Otherwise, if the current patch has an explicit official successor:

    - follow `currentPatch.nextPatch` (the mainline)

3. Otherwise, if there is only one child in the `parentId` tree:

    - follow that only child

4. If there are multiple children and none are explicitly disambiguated:

    - refuse redo (better than guessing)
    - This should be an invalid state if everything is operating correctly (i.e., official history always has `nextPatchId`, and user redo paths are either unique or detectable via `rootPatch`). If it happens, treat it as a bug or data corruption, not a normal user scenario.

This is the real reason `nextPatchId` exists: it makes “the official child” explicit so redo doesn’t accidentally step into someone else’s fork when `children.length > 1`.

### 5.6 Reset (discard private edits)

Reset returns the user to “tracking official.”

- delete patches starting at `rootPatchId` (cascade)
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

### 5.8 Status endpoints (what the UI needs)

For the reader UI, you usually want cheap queries like:

- is my branch clean? (`rootPatchId == null`)
- what is my HEAD? (`headPatchId`)
- what is official HEAD?
- do I need a rebase?

Those are all pointer comparisons + ancestry checks — the system stays predictable because history is immutable.

## 6. Reconciling concurrent edits: effect propagation model

In collaborative systems, multiple people often work on the same document at the same time.

Sometimes their edits are independent and can be combined mechanically. Other times they interact in subtle ways:

- one person fixes structure while another edits content
- one person reorders blocks while another annotates them
- upstream OCR is corrected while downstream work already exists

The core problem is not storing edits. It’s reconciling them in a way that preserves intent.

In this system there is a canonical “admin” history (the evolving OCR) and multiple user branches layered on top. When admin history changes, user edits must be reconciled against the updated past.

### 6.1 Rebase via effect propagation

Rebase is implemented as **effect propagation**.

Each patch can be read in two ways:

- a concrete operation (“replace this line text”, “remove this block”, “reorder these lines”)
- an abstract effect on later edits (“shift indices”, “permute order”, “invalidate paths”)

During rebase, admin patches are converted into effects and pushed forward through the user’s patch sequence. As the effect moves, user patches are rewritten so they continue to apply to the intended parts of the document.

The important distinction is:

- patches are not reapplied
- patches are reinterpreted

Rebase is answering:

> Given that the past has changed, what did this edit mean?

### 6.2 Core loop (single-pass per admin patch)

Let:

- `A = [A₁, A₂, …, Aₙ]` be admin patches since the fork point (oldest → newest)
- `U = [U₁, U₂, …, Uₘ]` be user patches since the fork point (oldest → newest)

For each admin patch `Aᵢ`:

1. Convert `Aᵢ` into an initial **Effect** `E`.
2. Scan the user list left-to-right, transforming `(Uⱼ, E)` into `(Uⱼ', E')`.
3. If a transform is unambiguous, keep going.
4. If it’s ambiguous, pause and request user choice.

At the end of this process, you get a rewritten user patch list `U*` which can be applied on top of the current admin head.

### 6.3 Effect construction (admin → effect)

Admin patches map to exactly one effect:

- add/remove on an array → `shift_up` / `shift_down`
- reorder on an array → `permute` (stored as an inverse permutation for composability)
- replace on a field → `content(path, oldValue, newValue)`
- otherwise → `identity`

The exact constructors and representations are specified in Appendix B.

### 6.4 Transform outcomes

At the interface level, `transform(userPatch, effect)` only has a few outcomes:

- **rewrite the user op** (retarget the `path`, rewrite a permutation, update `old_value`)
- **rewrite the effect** (a user structural edit shifts where the effect should land)
- **absorb the effect** (effect becomes identity because it’s been made redundant)
- **pause** (emit a conflict requiring keep\_admin / keep\_mine)

Internally this is driven by a path-intersection classifier and deterministic casework. The full matrix lives in Appendix B.

### 6.5 Output (immutability)

Patches are immutable. A successful rebase produces a *new* patch chain (`U₁'..Uₘ'`) on top of the latest admin head, and updates branch pointers:

- `rootPatchId = U₁'`
- `headPatchId = Uₘ'`

### 6.6 Pausing and resuming

Rebase is deterministic until it hits a user-choice conflict.

Practically it works as a two-phase workflow:

- **plan**: run effect propagation until completion or a choice conflict
- **commit**: after the every conflict is resolved, write the transformed patches on top of admin HEAD

### 6.7 Complexity and termination

- Each admin patch is processed in a single forward scan of the user patch list.
- Effects monotonically simplify (eventually identity).
- The algorithm is `O(|A| × |U|)` and terminates.

## 7. Conflicts resolution

Most interactions between patches are mechanical and can be resolved automatically:

- index shifts caused by insertions or deletions
- path updates after structural changes
- collapsing redundant operations

A conflict only occurs when two edits overlap in a way that makes intent ambiguous.

Typical cases:

- editing content inside something that was deleted upstream
- both sides modifying the same field differently
- structural edits that invalidate assumptions made by later patches

When this happens, the system does not guess.

### 7.1 Two resolution semantics

User-choice conflicts are resolved by choosing one of two consistent interpretations of history:

**keep\_admin**

- the updated canonical history is authoritative
- user edits are rewritten or discarded to fit the new past

**keep\_mine**

- the user edits are authoritative
- upstream effects are absorbed or rewritten so the user edits behave as if the change had always been present

This is not “which edit wins.” It’s which version of history future edits should assume.

### 7.2 keep\_mine as history reinterpretation

Under keep\_mine, the system forces later patches to keep behaving exactly as before, even though the past changed.

Conceptually, it rewrites the future under the assumption:

> “This is how the document has always looked.”

That same semantic shows up in more than just rebase:

- undo (pointer moves without mutating history)
- compression (removing a patch from history and rewriting what follows to compensate)

The detailed conflict taxonomy and the exact keep\_admin / keep\_mine rewrite rules are specified in Appendix B.

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

OCR in a reader isn’t a flat text file. It’s a structured, spatial document, and edits have **semantic meaning** (replace vs delete vs reorder), not just a before/after diff.

That’s why this system is operational (as opposed to snapshot-based):

- represent edits as a small typed patch language over the OCR structure
- store history as an immutable patch tree
- represent branches as pointers into that tree (with `rootPatchId` as the boundary for “my private fork”)

With that foundation, the workflows become consistent mechanics:

- undo/redo is pointer movement (with `nextPatchId` making the official child explicit)
- admin undo is conservative, with branch drag to avoid breaking downstream readers
- rebase retargets edits when history changes, and surfaces conflicts when intent becomes ambiguous
- snapshots + incremental replay keep it fast enough to use interactively

**What was hard (for me):**

- The reconciliation engine is a large state machine: exhaustive casework + validation (just look at the conflict table in Appendix B).
- Keeping invariants straight across features (redo disambiguation, canonical stability, no silent drift, safe deletion only for unreachable forks).
- Come up with a shared and collaborative model that doesn't blatantly diverges from the previously private nature of the application.

**What I’m proud of:**

- `rootPatchId` as a crisp fork boundary (clean separation: tracking vs private segment; makes reset/officialize/rebase well-defined).
- Rebase as **causal effect propagation** / semantic reinterpretation: upstream patches become effects (shift/permute/content) that change the context later edits are interpreted under, so user patches are retargeted instead of replayed blindly.
- Branch drag: relaxing admin undo without destabilizing downstream branches.
- Compression without extra behavior: treat “remove a patch from history” as a counterfactual change and reuse the same keep\_mine rewrite machinery to compensate.

## Appendix B: Rebase Semantics

This appendix is the “executable spec” for Section 6/7.

### B.0 Effect construction (Admin → Effect)

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

### B.1 Intersection Classification

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

### B.2 Deterministic Structural Transforms (No Conflict)

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

### B.3 Conflict Resolution Matrix

| Intersection    | effect.type  | user.op   | Conflict              | Auto | keep\_admin                               | keep\_mine                       |
| --------------- | ------------ | --------- | --------------------- | ---- | ----------------------------------------- | -------------------------------- |
| direct\_hit     | `shift_down` | `add`     | `shift_down_into_add` | ✓    | keep patch, bump effect index             | —                                |
| direct\_hit     | `shift_down` | `remove`  | `double_delete`       | ✓    | discard patch, absorb effect              | —                                |
| direct\_hit     | `permute`    | `reorder` | `reorder_collision`   | ✗    | discard user reorder, compose into effect | rewrite reorder as A⁻¹∘U, absorb |
| direct\_hit     | `content`    | `replace` | `content_conflict`    | ✗    | discard user replace                      | update old\_value, absorb        |
| ancestor\_hit   | `shift_down` | any       | `dead_zone`           | ✗    | discard user patch                        | resurrect deleted value, absorb  |
| descendant\_hit | any          | `remove`  | `reverse_dead_zone`   | ✗    | compensate delete                         | fold effect into delete          |
| descendant\_hit | any          | `add`     | `effect_shift`        | ✓    | shift effect path                         | —                                |
| descendant\_hit | any          | `reorder` | `effect_shift`        | ✓    | permute effect path                       | —                                |

**Invariant:**\
`keep_mine` typically absorbs the effect (effect → identity), while `keep_admin` typically preserves the effect, except where a compensating structural effect is required.
