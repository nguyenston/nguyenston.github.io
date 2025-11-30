import { visit } from "unist-util-visit";

/**
 * Plugin to convert HTML <figure> blocks into AST nodes
 */
export function remarkHtmlFigureToJsx() {
  return (tree) => {
    visit(tree, "html", (node, index, parent) => {
      const html = node.value;

      // Quick check: must contain an image tag to be relevant
      if (!html.includes('<img')) return;

      // Helper: Parse attributes from HTML string
      const parseAttributes = (attrString) => {
        const attrs = {};
        if (!attrString) return attrs;
        const regex = /([a-z0-9_-]+)="([^"]*)"/gi;
        let match;
        while ((match = regex.exec(attrString)) !== null) {
          attrs[match[1]] = match[2];
        }
        return attrs;
      };

      // --- CASE 1: <figure> Block ---
      if (html.includes('<figure')) {
        const figMatch = html.match(/<figure([^>]*)>/i);
        const figAttrs = figMatch ? parseAttributes(figMatch[1]) : {};

        const imgMatch = html.match(/<img\s+([^>]+)>/i);
        if (!imgMatch) return; // Should be there given our initial check
        const imgAttrs = parseAttributes(imgMatch[1]);

        const captionMatch = html.match(/<figcaption([^>]*)>([\s\S]*?)<\/figcaption>/i);
        const captionAttrs = captionMatch ? parseAttributes(captionMatch[1]) : {};
        const captionText = captionMatch ? captionMatch[2].trim() : "";

        // Construct Figure AST
        const children = [
          {
            type: "image",
            url: imgAttrs.src,
            alt: imgAttrs.alt || "",
            data: { hName: "img", hProperties: imgAttrs },
          }
        ];

        if (captionText) {
          children.push({
            type: "strong", // Markdown phrasing content
            data: { hName: "figcaption", hProperties: captionAttrs },
            children: [{ type: "text", value: captionText }],
          });
        }

        const figureNode = {
          type: "paragraph", // Markdown block content
          data: { hName: "figure", hProperties: figAttrs },
          children: children,
        };

        parent.children[index] = figureNode;
      }

      // --- CASE 2: Plain <img> Tag ---
      else {
        const imgMatch = html.match(/<img\s+([^>]+)>/i);
        if (imgMatch) {
          const imgAttrs = parseAttributes(imgMatch[1]);

          const imageNode = {
            type: "image",
            url: imgAttrs.src,
            alt: imgAttrs.alt || "",
            data: { hName: "img", hProperties: imgAttrs },
          };

          parent.children[index] = imageNode;
        }
      }
    });
  };
}
