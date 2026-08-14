# My PaperTrader — brand assets

**Concept: "Fold Line."** The ascending trend line *is* the crease in a folded sheet of paper — one continuous gesture holding both halves of the product: *paper* (practice, no real money) and *trading*. The faint line beneath the crease is the fold's shadow.

## Files

| File | Use |
|---|---|
| `icon.svg` | **Primary icon**, outlined. Dark surfaces, 24px and up — app header, sidebar, nav. |
| `icon-solid.svg` | **Small / unpredictable backgrounds.** Solid green field, dark crease. Favicon, PWA/app icons, social avatars. The outlined version's 1.5px border disappears below ~24px — use this instead. |
| `icon-mono.svg` | Single colour via `currentColor`. Tint anywhere: watermarks, print, one-colour placements. |
| `logo-lockup-dark.svg` | Horizontal lockup for dark backgrounds. README, social cards, decks. |
| `logo-lockup-light.svg` | Same for light backgrounds — uses the solid icon and a darker green so it stays legible on white. |

## Colours

| Token | Hex | Use |
|---|---|---|
| Brand green | `#22C55E` | The mark, "Trader" in the wordmark |
| Brand green (on light) | `#16A34A` | Light backgrounds — the brighter green fails contrast on white |
| Icon field (dark) | `#0E1512` | Outlined icon interior |
| Crease on solid | `#05140B` | Dark stroke inside the solid icon |
| Wordmark "My" | `#7D8892` dark bg · `#8A939C` light bg | Deliberately muted |
| Wordmark "Paper" | `#F2F4F6` dark bg · `#0B0D0E` light bg | |

## Wordmark

Treatment **A**: **My** muted · **Paper** in the primary text colour · **Trader** in brand green.

"My" carries the least meaning of the three words and shouldn't take equal weight — muting it keeps emphasis on the distinctive part of the name while the possessive still reads naturally.

**In the app, render the wordmark as live HTML text** beside `icon.svg` rather than embedding the lockup SVG — it stays crisp at any size, inherits the app's font, and remains accessible to screen readers and search engines. The lockup SVGs are for contexts where you can't control the markup (social previews, README, slides).

```html
<span class="text-[20px] font-[650] tracking-[-0.02em]">
  <span class="text-muted-foreground font-medium">My</span>
  <span class="text-foreground">Paper</span><span class="text-[#22C55E]">Trader</span>
</span>
```

## Guidance

- **Clear space:** keep at least half the icon's height free on all sides.
- **Don't** recolour the mark outside these tokens, add gradients or drop shadows, stretch it non-uniformly, or place the outlined icon on a light background.
- **Do** use `icon-solid.svg` any time the mark is under ~24px or sits on a background you don't control.
- The crease and arrow are a single visual idea — don't separate them or use the arrow alone.
