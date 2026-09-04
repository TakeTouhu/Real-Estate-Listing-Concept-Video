/**
 * Freeze an object graph, not just its outermost object.
 *
 * `Object.freeze` is one level deep, so a "frozen" catalog entry still hands
 * out a live `resolutions` array that any consumer can push to. That is not a
 * theoretical concern here: `OPEN_VIDEO_CAPABILITY` is shared **by reference**
 * between the capability provider and the model catalog precisely so the two
 * cannot drift, which also means a single mutation through either reference
 * poisons both — and the descriptor ADR-0019 froze is the one that decides what
 * a paid request may ask for.
 *
 * `readonly` in TypeScript is a compile-time courtesy. It disappears at runtime,
 * it does not survive a cast, and it does not apply to a JavaScript consumer at
 * all. This is the runtime half.
 *
 * Deliberately not implemented by serializing and re-parsing: that would drop
 * functions and prototypes, silently rewrite `undefined`, and produce a *copy*,
 * which defeats the shared-reference identity the catalog depends on.
 *
 * The `seen` set guards against cycles. The catalog data has none today, but an
 * infinite recursion in a module-level constant is a startup crash, and the
 * guard costs one allocation.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const asObject = value as unknown as object;
  if (seen.has(asObject)) return value;
  seen.add(asObject);

  for (const key of Object.getOwnPropertyNames(asObject)) {
    const descriptor = Object.getOwnPropertyDescriptor(asObject, key);
    // Skip accessors: reading a getter to freeze its result would run arbitrary
    // code and freeze a value that is not actually part of this graph.
    if (descriptor === undefined || !("value" in descriptor)) continue;
    deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}
