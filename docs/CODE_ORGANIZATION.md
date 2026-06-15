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
- `capital-tracking-service.ts` + `capital-tracking-business-logic.ts`
- `risk-monitoring-service.ts` + `risk-monitoring-business-logic.ts`

### DRY and Separation of Concerns

- **DRY but separated by concerns**: Keep code DRY (Don't Repeat Yourself) while maintaining clear separation of concerns
  - Extract shared logic into reusable functions/modules
  - Group related functionality together, but don't mix unrelated concerns
  - Each module/function should have a single, clear responsibility

### Shared Service Pattern

When multiple API routes need the same logic, extract to a service:

```typescript
// Before: Duplicated in 4 API routes
async function getRealTradingConfig() { ... }

// After: Single source in trading-config-service.ts
import { getRealTradingConfig } from '@/lib/trading/services/trading-config-service';
```

See `trading-config-service.ts` for an example.

## Directory Organization

### Organize by Function Using Subdirectories

Use subdirectories to group code by function/concern, similar to `lib/` and `scripts/`:

- Create subdirectories for distinct functional areas (e.g., `lib/price-data/`, `lib/trading/`, `scripts/data-fetching/`)
- Use nested subdirectories for further organization when needed (e.g., `lib/price-data/api-clients/`, `lib/infrastructure/auth/`)
- Group related files together in the same subdirectory

### Examples from Codebase

- `lib/` organized by domain: `backtesting/`, `defi/`, `external-services/`, `infrastructure/`, `price-data/`, `strategy/`, `trading/`, `wallet/`
- `scripts/` organized by purpose: `analysis/`, `data-fetching/`, `data-generation/`, `testing/`, `verification/`

## File Size Guidelines

| Threshold | Status | Action |
|-----------|--------|--------|
| **< 600 lines** | ✅ Good | No action needed |
| **600-800 lines** | ⚠️ Warning | Consider splitting when adding new code |
| **> 800 lines** | ❌ Must split | Required before merging new features |

### When to Split Files

Split a file when:
- **Multiple distinct responsibilities** - File handles unrelated concerns (e.g., UI + API + business logic)
- **Natural domain boundaries** - Code can be grouped by feature (e.g., `user-auth.ts` vs `user-profile.ts`)
- **Reusability opportunities** - Some code could be shared across modules
- **Testing complexity** - File is hard to test due to mixed concerns
- **File grows past warning threshold** - Proactively split before reaching 800 lines

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
- **Client Components**: Use error boundaries (already implemented)
- **Redis**: Retry logic is built-in (3 attempts)
- **Scraping**: Handle timeouts and failures gracefully
- Log errors with context (what failed, why, relevant data)
