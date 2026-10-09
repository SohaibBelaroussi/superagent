# Third-party notices

Superagent is licensed under the [MIT License](LICENSE). Some parts come from other projects, under their own licences. Dependencies installed from npm or pulled as images keep their own licence files and are not listed here.

## Mastra design tokens

`apps/web/src/styles/theme.css` and the surface utilities in `apps/web/src/styles/app.css` adapt the design tokens of Mastra's design system, [`@mastra/playground-ui`](https://github.com/mastra-ai/mastra/tree/main/packages/playground-ui):
- its colour ramps;
- its fill, border and elevation ladders;
- its text roles;
- its control sizes.

- **Copyright:** Mastra.
- **Licence:** Apache License, Version 2.0. A copy is in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt).
- **Changes:** we picked the tokens the app uses, regrouped them into one file, and added our own brand colour. The phone app's `apps/mobile/src/ui/tokens.ts` is generated from that file, with each colour computed to sRGB for each theme.

## Mona Sans

The web app bundles the Mona Sans variable font through `@fontsource-variable/mona-sans`. The phone app ships three of its static cuts (Regular, Medium and SemiBold) from the Mona Sans release, in `apps/mobile/assets/fonts`, with the licence beside them.

- **Copyright:** The Mona Sans Project Authors.
- **Licence:** SIL Open Font License 1.1. A copy is in [licenses/OFL-1.1-Mona-Sans.txt](licenses/OFL-1.1-Mona-Sans.txt).
