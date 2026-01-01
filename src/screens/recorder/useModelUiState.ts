import { useCallback, useEffect, useState, type SetStateAction } from "react";

type ModelUiState = {
  modelText: string | null;
  waitingModel: boolean;
  isTranscribing: boolean;
};

type UseModelUiStateResult = {
  modelText: string | null;
  waitingModel: boolean;
  isTranscribing: boolean;
  setModelText: (action: SetStateAction<string | null>) => void;
  setWaitingModel: (action: SetStateAction<boolean>) => void;
  setIsTranscribing: (action: SetStateAction<boolean>) => void;
  resetModelUiState: () => void;
};

export function useModelUiState(sentenceHash: string): UseModelUiStateResult {
  const [modelState, setModelState] = useState<ModelUiState>({
    modelText: null,
    waitingModel: false,
    isTranscribing: false,
  });

  const resetModelUiState = useCallback(() => {
    setModelState({
      modelText: null,
      waitingModel: false,
      isTranscribing: false,
    });
  }, []);

  useEffect(() => {
    resetModelUiState();
  }, [sentenceHash, resetModelUiState]);

  const setModelText = useCallback((action: SetStateAction<string | null>) => {
    setModelState((prev) => ({
      ...prev,
      modelText:
        typeof action === "function"
          ? (action as (p: string | null) => string | null)(prev.modelText)
          : action,
    }));
  }, []);

  const setWaitingModel = useCallback((action: SetStateAction<boolean>) => {
    setModelState((prev) => ({
      ...prev,
      waitingModel:
        typeof action === "function"
          ? (action as (p: boolean) => boolean)(prev.waitingModel)
          : action,
    }));
  }, []);

  const setIsTranscribing = useCallback((action: SetStateAction<boolean>) => {
    setModelState((prev) => ({
      ...prev,
      isTranscribing:
        typeof action === "function"
          ? (action as (p: boolean) => boolean)(prev.isTranscribing)
          : action,
    }));
  }, []);

  return {
    modelText: modelState.modelText,
    waitingModel: modelState.waitingModel,
    isTranscribing: modelState.isTranscribing,
    setModelText,
    setWaitingModel,
    setIsTranscribing,
    resetModelUiState,
  };
}
