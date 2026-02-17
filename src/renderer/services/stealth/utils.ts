// Utility for Base64 conversion in browser/renderer environment
export function uint8ToBase64(arr: Uint8Array): string {
  return btoa(Array.from(arr).map(b => String.fromCharCode(b)).join(''));
}

export function base64ToUint8(str: string): Uint8Array {
  const binary = atob(str);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}
