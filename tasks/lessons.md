# Pigeon — Lessons Learned

_Updated as we go. Check this at session start._

- For folder read regressions, verify the actual queued article IDs as well as badge values. Clearing a count alone must never stand in for marking the remaining stories read.
- Native UI tests should use the inspected screen hierarchy: only Today includes a count in its navigation title, and narrow iPad toolbars can put Read actions inside More.
- Hydrating a shared saved collection for a folder action must preserve its unrelated articles and pagination. Verify saved read flags after mutation acknowledgement, not only while the outbox still contains the action.
- Re-read current navigation totals after asynchronous cache lookups before deciding whether the saved articles cover the complete folder.
