class MockStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] || null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

global.Storage = MockStorage as any;
const ls = new MockStorage();
const ss = new MockStorage();

Object.defineProperty(window, 'localStorage', { value: ls, writable: true, configurable: true });
Object.defineProperty(window, 'sessionStorage', { value: ss, writable: true, configurable: true });
Object.defineProperty(global, 'localStorage', { value: ls, writable: true, configurable: true });
Object.defineProperty(global, 'sessionStorage', { value: ss, writable: true, configurable: true });
