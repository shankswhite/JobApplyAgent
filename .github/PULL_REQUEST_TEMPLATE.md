## What does this PR do?

<!-- Describe the change in 1-3 sentences -->

## Related issue

<!-- REQUIRED: Link the issue this PR addresses. PRs without a related issue will be closed. -->
<!-- Format: Fixes #123 / Closes #123 -->
<!-- Bug fixes can skip this if the fix is obvious (e.g., typo, crash). -->

## Type of change

- [ ] Bug fix
- [ ] New feature (auto-fill engine, cover letter renderer, integrations)
- [ ] ATS support (new portal, fixed selectors)
- [ ] Documentation
- [ ] Refactor (no behavior change)

## Checklist

- [ ] I have read [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md)
- [ ] I linked a related issue above (required for features and architecture changes)
- [ ] My PR does not include personal data (CV, email, real names, phone, GPA, etc.)
- [ ] I ran `node test-all.mjs` and all tests pass
- [ ] My changes respect the [Data Contract](../blob/main/DATA_CONTRACT.md) (no modifications to user-layer files like `data/section-g-boilerplate.md`)
- [ ] For ATS-specific changes: I attached `node scripts/probe-form.mjs <url>` output for the ATS in question
