import { describe, expect, it } from "vitest";
import {
  continuationPrompt,
  isRetryableFailure,
  shouldRetryOutcome,
} from "../src/daemon/classify.js";

describe("失败分类", () => {
  it("运行时的 errorRetryable 是权威信号", () => {
    expect(isRetryableFailure("configuration_error", true)).toBe(true);
    expect(isRetryableFailure("network_error", false)).toBe(false);
  });

  it("没有运行时信号时按错误码判断", () => {
    expect(isRetryableFailure("network_error")).toBe(true);
    expect(isRetryableFailure("rate_limit")).toBe(true);
    expect(isRetryableFailure("provider_5xx")).toBe(true);
    expect(isRetryableFailure("CONFIGURATION_ERROR")).toBe(false);
    expect(isRetryableFailure("invalid_model_request")).toBe(false);
    expect(isRetryableFailure("authentication_failed")).toBe(false);
    expect(isRetryableFailure(undefined)).toBe(false);
  });

  it("成功不重试，被中断按可重试处理", () => {
    expect(shouldRetryOutcome("success")).toBe(false);
    expect(shouldRetryOutcome("interrupted")).toBe(true);
    expect(shouldRetryOutcome("failed", "network_error")).toBe(true);
    expect(shouldRetryOutcome("failed", "invalid_model_request")).toBe(false);
  });

  it("续跑提示词带上原始错误与原任务", () => {
    const prompt = continuationPrompt("跑一下巡检", "连接被重置");
    expect(prompt).toContain("连接被重置");
    expect(prompt).toContain("跑一下巡检");
    expect(prompt).toContain("请从中断处继续");
  });
});
