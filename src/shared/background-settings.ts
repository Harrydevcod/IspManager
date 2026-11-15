export type BackgroundSettings = {
  available: boolean;
  keepRunning: boolean;
  canStartAtLogin: boolean;
  openAtLogin: boolean;
};

export type BackgroundSettingsChange = { keepRunning: boolean } | { openAtLogin: boolean };
