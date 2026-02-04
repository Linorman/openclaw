export * from "./accounts.js";
export * from "./message-context.js";
export * from "./message-dispatch.js";
export * from "./monitor.js";
export * from "./probe.js";
export * from "./send.js";
export * from "./types.js";

// NapCat lifecycle management
export {
  // Types
  type NapCatInstallResult,
  type NapCatStatus,
  type NapCatStartResult,
  type QuickLoginItem,
  // Installation
  installNapCatQQ,
  // Detection and status
  detectNapCatQQ,
  getNapCatStatus,
  // Lifecycle management
  startNapCatQQ,
  stopNapCatQQ,
  killExistingNapCat,
  // Configuration
  readNapCatConfig,
  updateNapCatConfig,
  // QR Code
  getCapturedQRCode,
  resetQRCodeCapture,
  waitForQRCode,
  // Port management
  isPortAvailable,
  findAvailablePorts,
  // Login API
  checkNapCatLoginViaOneBot,
  waitForNapCatLogin,
  // Quick login API
  getNapCatQuickLoginList,
  setNapCatQuickLogin,
} from "./napcat-lifecycle.js";
