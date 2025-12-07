---
title: "Simulating Absolute Positioning with Relative CSS for Continuous Text Scanning"
published: 2025-11-17
image: "./example.jpg"
description: Solving Yomitan scanning challenges for a mokuro frontend.
tags: [mokuro,css]
category: Projects
draft: false
---

When building [Mokuro Library](https://github.com/nguyenston/mokuro-library), 
a web-based reader for [mokuro](https://github.com/kha-white/mokuro), I encountered a specific 
conflict between frontend layout requirements and the text scanning capabilities of [Yomitan](https://github.com/yomidevs/yomitan). 
To render text boxes precisely over speech bubbles, `position: absolute` is the standard tool. 
However, using absolute positioning breaks the DOM continuity required for dictionary popups 
to scan phrases across multiple lines.

This post details how I implemented a faux-absolute flow using `position: relative` and negative margins to trick the browser into stacking elements like an absolute layout, while tricking Yomitan into seeing a continuous sentence.

## 1. Mokuro and Yomitan

**Mokuro** is a tool that processes manga pages to generate a `.mokuro` file—a 
JSON structure containing OCR data overlaid on the original image. 
It organizes text into **Blocks** (speech bubbles), which contain multiple **Lines**. 
Critically, every line has its own coordinate bounding box.

```json
{
  "blocks": [
    {
      "box": [100, 100, 300, 200],
      "font_size": 24,
      "vertical": true,
      "lines": ["こんにちは", "元気ですか"],
      "lines_coords": [
        [[150, 100], [180, 100], ...], // Coordinates for line 1
        [[120, 100], [150, 100], ...]  // Coordinates for line 2
      ]
    }
  ]
}
```

We want to render these lines over the image so the user can hover/select them with Yomitan to get definitions.

## 2. The 3 ways to render

When rendering this data in a Svelte component like `OcrOverlay.svelte`, we have three main approaches to displaying the text.

### Option 1: Concatenation
We could simply join all the lines in a block and render them in a single `<span>`.

```html
<div class="text-block">
  こんにちは元気ですか
</div>
```

* **Pros:** Yomitan scans this perfectly. It sees one continuous string: `こんにちは元気ですか`.
* **Cons:** It looks terrible. It completely ignores the `lines_coords`. The text won't match the bubbles in the image.

### Option 2: Line Breaks
This is what the official [mokuro-reader](https://github.com/ZXY101/mokuro-reader) has implemented.

We can render each line separated by `<br>` tags or inside `<p>`s.

```html
<div class="text-block">
  <p>こんにちは</p>
  <p>元気ですか</p>
</div>
```

* **Pros:** Visually better than Option 1. Simple, lightweight, easy to maintain.
* **Cons:** Still doesn't match the specific coordinates of the Mokuro format (e.g., if one line is offset slightly).
* **Doesn't play nice with Yomitan:** A `<p>` (or `<div>`) is a block-level element. Yomitan's text scanner treats block boundaries as sentence terminators. If you scan across the lines, Yomitan sees `こんにちは` **STOP** `元気ですか`. It cannot recognize words that span across lines. This issue is documented [here](https://github.com/kha-white/mokuro/issues/139).

### Option 3: Absolute Positioning
This is what I was going for initially. We use `position: absolute` to place each line exactly where the OCR said it should be.

```html
<div class="container" style="position: relative;">
  <div style="position: absolute; left: 10%; top: 20%; width: 80px;">
    こんにちは
  </div>
  <div style="position: absolute; left: 15%; top: 25%; width: 90px;">
    元気ですか
  </div>
</div>
```

* **Pros:** Gives most control to the user. Combining with an editing feature, the user can have a great degree of control on which text goes where.
* **Cons:** verbose and more complicated to implement and maintain.
* **Still doesn't play nice with Yomitan :(**

## 3. Picking at Yomitan's scanning behavior

Yomitan relies on a specific class, `DOMTextScanner`, to traverse the DOM and reconstruct sentences. To decide if two text nodes belong to the same sentence or if they should be separated, the scanner analyzes the CSS properties of their container elements.

The logic is strictly hierarchical: it first checks **Position**, then checks **Display**.

### 3.1. Position Check (Absolute vs. Relative)
The scanner assumes that any element removed from the normal document flow (like a sidebar, tooltip, or overlay) marks a semantic break in the text.

* **Absolute / Fixed:** When the scanner encounters `position: absolute`, `fixed`, or `sticky`, it explicitly sets the newline count to `2`. This forces a paragraph break (`\n\n`), making it impossible to scan a word that crosses this boundary.
* **Relative:** The scanner does **not** check for `position: relative`. It falls through this check, keeping the newline count at `0`.

```javascript
// ext/js/dom/dom-text-scanner.js

static getElementSeekInfo(element) {
    // ...
    switch (style.position) {
        case 'absolute':
        case 'fixed':
        case 'sticky':
            newlines = 2; // <--- Forces a hard paragraph break
            break;
    }
    // ...
}
```


### 3.2. Display Check (Block vs. Inline)
If the position is "safe" (static or relative), the scanner then evaluates the `display` property using the helper method `doesCSSDisplayChangeLayout`.

* **Block / Flex / Grid:** These values are interpreted as layout boundaries. The method returns `true`, causing the scanner to insert a single newline (`\n`). This breaks compound words spread across multiple elements.
* **Inline / Inline-Flex:** These values fall into the `default` case, returning `false`. The scanner treats them as continuous text, allowing it to concatenate the contents (`Line 1` + `Line 2`).

```javascript
// ext/js/dom/dom-text-scanner.js

static doesCSSDisplayChangeLayout(cssDisplay) {
    // ...
    switch (cssDisplay) {
        case 'block':     // <--  These are div or p elements
        case 'flex':      // <--- Even 'flex' triggers a break
        case 'grid':
        case 'table':
            return true;  // <--- Signals a layout break (newlines = 1)
        default:
            return false; // <--- 'inline-flex' falls here (newlines = 0)
    }
}
```


**Conclusion:** To support layout positioning *and* text scanning simultaneously, our elements must bypass the first check (by using `relative`) and pass the second check (by using `inline-flex`).

## 4. The Hack: replicating absolute positioning manually

We need a way to get the **visual control** of `position: absolute` but the **DOM continuity** of `display: inline`.

The solution implemented in `OcrOverlay.svelte` uses a combination of `inline-flex`, `position: relative`, and negative margins to trick the browser and the scanner.

### 4.1. Implementation

Instead of `div`s, we use `span` tags. Instead of `absolute`, we use `relative`.

```svelte
<!-- /frontend/src/lib/components/OcrOverlay.svelte -->
{#each block.lines as line}
  <span
    class="inline-flex relative items-center align-top pointer-events-auto"
    style="
      width: {width}%;
      height: {height}%;
      /* Position relative to the start of the block */
      left: {(block.vertical ? -100 : 0) + width + relative_x_min}%;
      top: {relative_y_min}%;

      /* THE TRICK: Collapse the space so the next element starts at 0,0 */
      margin-bottom: -{block.vertical ? height : 0}%;
      margin-left: -{block.vertical ? 0 : width}%;
    "
  >
    {ligaturize(line, block.vertical)}
  </span>
{/each}
```

### 4.2. CSS Logic

We need the browser to treat every line as if it starts at the same "origin" point `(0,0)` of the container, allowing us to use `left` and `top` to position them relative to the container, all while keeping them in the flow.

1.  **`display: inline-flex`**: Yomitan treats `inline` elements as continuous text (0 newlines).
2.  **`position: relative`**: This keeps Yomitan from getting blocked at the boundary (unlike `absolute`), but allows the use of `top` and `left` properties for positioning.
3.  **`width` / `height`**: We set the exact dimensions required by the OCR data.
4.  **`margin-bottom` / `margin-left`**: By setting the margin equal to the negative size of the element, we reduce the element's effective footprint in the flow to zero. The *next* element in the loop will flow into the exact same starting position as the current element.
5.  **`align-top`**: Standard `inline` elements align to the (text) baseline of the parent. To ensure the bounding box location is **exactly** the same as the absolute div counterpart, we must force top alignment. This prevents the subtle vertical shifts caused by font metrics that usually plague inline layouts.

#### How `inline`, `relative`, and margin work together

Think of `inline` elements as a single character in a line of text. Each time you type a character, the cursor moves right by the character's width,
and the character takes up the space the cursor left behind. The margin controls the spacing between the characters, and the great thing is that this spacing can become negative! 
When the spacing is exactly the negative of the previous character's width, the next character will be rendered right on top of the previous one.

`relative`, like `absolute`, allows for `top` and `left` attributes to control the location of your element. But unlike `absolute`, 
which sets the location relative to the element's parent, this coordinate is relative to the initial position
of the element. That is why we need to use margin collapse to shift all elements' initial positions to their parent's origin.

#### Handling vertical text

You might notice the CSS logic switches based on `block.vertical`. This is necessary because Japanese manga frequently alternates between horizontal and vertical text layouts, which fundamentally changes how the browser calculates "inline" flow.

* **Horizontal Mode:**
    * Flow is Left-to-Right and Top-to-Bottom.
    * We collapse the width using `margin-left: -width%`.

* **Vertical RL Mode:**
    * Flow is Top-to-Bottom and **Right-to-Left**.
    * We collapse the height using `margin-bottom: -height%`.
    * **Coordinate Regularization:** In `vertical-rl`, the flow starts from the right. We apply a `-100%` offset to the `left` property to
      shift the coordinate back to the left side of the parent.

### 4.4. Result

Visually, the text and bounding box locations are **exactly** the same as using absolute `div` elements.

To Yomitan's scanner, the DOM looks like this:
`<span>Line 1</span><span>Line 2</span>`.
Because they are `inline-flex` and technically adjacent in the flow, Yomitan concatenates them into `Line 1Line 2`, allowing it to detect words that wrap from the bottom of one line to the top of the next. We get the best of both worlds: maximum control of layout and painless Yomitan usage.
