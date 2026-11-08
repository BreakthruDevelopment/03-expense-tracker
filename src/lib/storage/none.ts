import { type StorageDriver, StorageUnavailableError } from "./types";

/** No bucket configured in production: scanning is off, manual entry still works. */
export function createNoneDriver(): StorageDriver {
  const unavailable = async (): Promise<never> => {
    throw new StorageUnavailableError();
  };
  return {
    kind: "none",
    signUpload: unavailable,
    signDownload: unavailable,
    put: unavailable,
    head: async () => null,
    read: async () => null,
    remove: async () => undefined,
  };
}
