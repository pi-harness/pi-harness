/** Read only own data properties from an untrusted panel payload. */
export function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor | undefined>;
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result[key] = descriptorValue(descriptor);
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Return a bounded dense array containing only own data properties. */
export function ownArray(value: unknown, maximum = Number.MAX_SAFE_INTEGER): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Array.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor | undefined>;
    const lengthDescriptor = descriptors.length;
    const lengthValue = descriptorValue(lengthDescriptor);
    if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0) return undefined;
    const length = lengthValue;
    if (length > maximum) return Array.from({ length: maximum }, (_, index) => descriptorValue(descriptors[String(index)]));
    if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))) return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result.push(descriptorValue(descriptor));
    }
    return result;
  } catch {
    return undefined;
  }
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
}
