<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- All app data goes through `src/services/api.ts` (typed models + mock implementations) so a real local backend can replace it without touching pages.
- Cross-page client state (settings/theme, Review Bin, clean-up session) lives in `src/lib/vault-store.tsx`.
