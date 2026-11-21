# Migration plan

## Summary

The migration moves **all pages** to the new format. It runs in three steps:

1. **Export.** Read every page from the old store.
2. **Convert.** Rewrite each page as Markdown with a `meta.json` file.
3. **Verify.** Compare page counts and checksums.

## Risks

| Risk | Likelihood | Mitigation |
| - | - | - |
| Lost attachments | Low | Checksums before and after |
| Slow export | Medium | Run it overnight |

> **Note:** pages edited during the migration are copied again at the end.

```bash
docsync migrate --from old.db --to ./workspace
```
