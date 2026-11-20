// jsdom has no layout, so it can't measure text. The menus only need some
// coordinates to place themselves, so report empty boxes.
const emptyRect = () => new DOMRect(0, 0, 0, 0);
const emptyRects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
for (const proto of [Range.prototype, Element.prototype]) {
  (proto as { getClientRects: () => DOMRectList }).getClientRects ??= emptyRects;
  (proto as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect ??= emptyRect;
}
Element.prototype.scrollIntoView ??= () => {};
