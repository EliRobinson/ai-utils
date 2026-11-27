# Concern checklist

Before you write code, pick the 3 to 5 risks below that this change could get wrong, including ones the task didn't mention. Write each as one concrete bug in your own code: the line and the edit. After green, plant it, run the tests, see a failure, revert.

Each row gives one bug shape per language. Use the shape, not the literal code.

| Concern | Go | Python | TypeScript | A test that kills it |
|---|---|---|---|---|
| Fail-open on error | `if err != nil { return true, nil }` in a check | `except Exception: return True` | `catch { return allowed }` | Make the dependency fail; assert access is denied or the run stops |
| Swallowed error or default return | `if err != nil { return nil }` | `except Exception: return []` | `.catch(() => undefined)` | Make the dependency fail; assert the error reaches the caller with its message or status, and that no internal detail leaks to clients |
| Missing auth, tenant or ownership check | Delete `if obj.OrgID != user.OrgID { return ErrForbidden }` | Delete the `if obj.owner_id != user.id: raise Forbidden` guard | Drop the `where: { orgId }` filter from the query | A user from org B reads or writes org A's object: 403 or 404 |
| Expiry or time bound not enforced | `now.After(exp)` → `now.After(exp.Add(time.Hour))`, or delete the check | `<` ↔ `<=` on `expires_at`; ignore `nbf` | `Date.now() > exp` → `Date.now() >= exp + skew` | Fixed clock: accepted at exp − 1 s, rejected at exp and exp + 1 s |
| Silent environment fallback | `if url == "" { url = prodURL }` | `os.environ.get("API_URL", PROD_URL)` | `process.env.MODE ?? "dev"` | Missing variable: startup fails with a clear error, no default |
| Boundary or off-by-one | `>` ↔ `>=`; `len(s)-1` ↔ `len(s)` | `[1:]` ↔ `[:]`; `range(n)` ↔ `range(n + 1)` | `i < pageSize` ↔ `i <= pageSize` | Cases at boundary − 1, boundary, boundary + 1 in one table |
| Race or missing lock | Delete `mu.Lock()` / `defer mu.Unlock()` | Delete `with lock:`; check-then-act outside a transaction | Read-modify-write across an `await` without a guard | Parallel callers (`go test -race`, threads, `Promise.all`); assert a count invariant |
| Non-constant-time secret comparison | `subtle.ConstantTimeCompare(a, b) == 1` → `string(a) == string(b)` | `hmac.compare_digest(a, b)` → `a == b` | `timingSafeEqual(a, b)` → `a === b` | Timing is hard to observe in a unit test. Keep the comparison in one small, tested helper. Usually "not worth a unit test": say so in the report |

## UI components

| Concern | Bug to plant | A test that kills it |
|---|---|---|
| A prop or variant ignored | Drop the prop from the spread; `defaultVariants` → `{}` | Render each variant; assert the attribute, role or state it drives. Assert class strings only for the default |
| Disabled or aria state not applied | Drop `aria-disabled`, `aria-invalid`, `aria-describedby` or `aria-labelledby` | Query by role and accessible name; assert the attribute and that the interaction is blocked |
| Controlled vs uncontrolled drift | Internal state overrides `value`; `defaultValue` ignored | One case table runs both modes: type, then assert the shown value and the callback |
| The caller's handler or id dropped | `id ?? generatedId` → `generatedId`; the caller's `onChange` never called | Pass an id or a handler; assert it is used, or called with the value |

## When property-based tests apply

The change parses, serializes, round-trips or transforms data, or handles money, dates, ranking or sorting. Write one property per invariant: round-trip equality, order preserved, sum conserved, idempotence. Tools: Hypothesis (Python), fast-check (TypeScript), rapid (Go). UI props rarely qualify; say "not applicable" rather than forcing one.
