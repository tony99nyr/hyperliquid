# Code Organization

## Function Design Principles

### Pure Functions

- **Prefer pure functions**: Functions should be pure when possible (no side effects, same input = same output)
  - Pure functions are easier to test, reason about, and reuse
  - When side effects are necessary (I/O, state mutations), isolate them and keep business logic pure

### Business Logic Extraction Pattern

For complex services with mixed I/O and business logic, use the `*-business-logic.ts` pattern:

```
service-name/
├── my-service.ts              # Main service with I/O operations
└── my-service-business-logic.ts  # Pure functions only
```

Benefits:
- **Testability**: Pure functions can be tested without mocking
- **Reusability**: Business logic can be used in multiple contexts
- **Clarity**: Clear separation between "what" (business logic) and "how" (I/O)

Examples in codebase:
- `src/lib/ladder/ladder-fire-service.ts` (I/O) over `ladder-risk-business-logic.ts` (pure)
- `src/lib/ladder/ladder-expiry-alert-service.ts` + `ladder-expiry-alert-business-logic.ts`
- `src/lib/household/household-exposure-service.ts` + `household-exposure-business-logic.ts`

### DRY and Separation of Concerns

- **DRY but separated by concerns**: Keep code DRY (Don't Repeat Yourself) while maintaining clear separation of concerns
  - Extract shared logic into reusable functions/modules
  - Group related functionality together, but don't mix unrelated concerns
  - Each module/function should have a single, clear responsibility

### Shared Service Pattern

When multiple API routes need the same logic, extract to a service:

```typescript
// Both cron routes (auto-exit and reconcile-positions) resolve their bearer from one place
import { getAutoExitCronSecret } from '@/lib/auto-exit/auto-exit-config';
```

See `src/lib/auto-exit/auto-exit-config.ts` for an example.

## Directory Organization

### Organize by Function Using Subdirectories

Use subdirectories to group code by function/concern, similar to `lib/` and `scripts/`:

- Create subdirectories for distinct functional areas (e.g., `src/lib/ladder/`, `src/lib/trading/`, `scripts/analysis/`)
- Use nested subdirectories for further organisation when needed (e.g., `src/lib/infrastructure/auth/`, `scripts/analysis/profit-review/`)
- Group related files together in the same subdirectory

### Examples from Codebase

- `src/lib/` organised by domain: `auto-exit/`, `backtest/`, `cockpit/`, `health/`, `hyperliquid/`, `ladder/`, `performance/`, `risk/`, `rubric/`, `scout/`, `strategy/`, `trading/`, `watch/`, `ws/` and more
- `scripts/` holds flat entrypoints (one per `pnpm` script); multi-file studies live under `scripts/analysis/`

## File Size Guidelines

| Threshold | Status | Action |
|-----------|--------|--------|
| **≤ 600 lines** | ✅ Good | No action needed |
| **> 600 lines** | ❌ Lint error | eslint `max-lines` (600, blank lines and comments skipped) fails `pnpm lint`. Split before committing. Tests and a few vendored files are exempt (`eslint.config.mjs`). |

### When to Split Files

Split a file when:
- **Multiple distinct responsibilities** - File handles unrelated concerns (e.g., UI + API + business logic)
- **Natural domain boundaries** - Code can be grouped by feature (e.g., `user-auth.ts` vs `user-profile.ts`)
- **Reusability opportunities** - Some code could be shared across modules
- **Testing complexity** - File is hard to test due to mixed concerns
- **File nears the limit** - Proactively split before reaching 600 lines

### How to Split Large Files

Split large files by:
- **Feature/domain boundaries** - Group by business domain (orders, users, payments)
- **Functionality groups** - Separate utilities, types, constants, business logic
- **I/O vs pure logic** - Use the `*-business-logic.ts` pattern (see above)
- **Component hierarchies** - Extract child components into separate files
- **Public vs internal** - Keep public API in main file, internals in separate files

## Performance

- Use `async`/`await` consistently (no mixing with Promise chains)
- Avoid large client bundles:
  - Lazy load heavy dependencies
  - Code split large components
  - Use dynamic imports when appropriate
- Optimize images with `next/image`
- Consider memoization for expensive client-side calculations

## Error Handling

- **API Routes**: Always wrap in try-catch and return proper error responses
  - Return generic error messages to clients: `{ error: 'User-friendly message' }`
  - Log detailed errors server-side: `console.error('Error details:', errorMessage)`
  - Never expose stack traces, internal paths, or implementation details to clients
- **Background loops and alerts**: fail soft (catch and log) so an alert or feed outage never breaks the money path
- Log errors with context (what failed, why, relevant data)
