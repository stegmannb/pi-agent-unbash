export interface UnbashRuntimeState {
  unbashEnabled: boolean;
  userDisabled: boolean;
}

export function getConfiguredEnabled(configEnabled: boolean, projectEnabled?: boolean): boolean {
  if (projectEnabled === false) return false;
  return configEnabled;
}

export function getSessionStartState(
  configEnabled: boolean,
  projectEnabled: boolean | undefined,
  userDisabled: boolean,
): UnbashRuntimeState {
  if (userDisabled) {
    return { unbashEnabled: false, userDisabled: true };
  }

  return {
    unbashEnabled: getConfiguredEnabled(configEnabled, projectEnabled),
    userDisabled: false,
  };
}

export function getReloadState(
  currentState: UnbashRuntimeState,
  configEnabled: boolean,
  projectEnabled?: boolean,
): UnbashRuntimeState {
  if (currentState.userDisabled) {
    return currentState;
  }

  return {
    unbashEnabled: getConfiguredEnabled(configEnabled, projectEnabled),
    userDisabled: false,
  };
}

export function getEnabledCommandState(): UnbashRuntimeState {
  return { unbashEnabled: true, userDisabled: false };
}

export function getDisabledCommandState(): UnbashRuntimeState {
  return { unbashEnabled: false, userDisabled: true };
}

export function getToggledCommandState(currentEnabled: boolean): UnbashRuntimeState {
  const unbashEnabled = !currentEnabled;
  return {
    unbashEnabled,
    userDisabled: !unbashEnabled,
  };
}

export function hasSessionOverride(
  currentEnabled: boolean,
  configEnabled: boolean,
  projectEnabled?: boolean,
): boolean {
  return currentEnabled !== getConfiguredEnabled(configEnabled, projectEnabled);
}
