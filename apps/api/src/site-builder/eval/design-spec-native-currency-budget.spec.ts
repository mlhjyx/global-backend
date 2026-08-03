import { describe, expect, it } from "vitest";

import {
  DesignSpecNativeCurrencyBudgetGuard,
  designSpecNativeCurrencyForDispatch,
} from "./design-spec-native-currency-budget";

describe("design_spec native-currency budget guard", () => {
  it("keeps CNY and USD reservations and settlements independent", () => {
    const budget = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: "100",
      USD: "200",
    });
    expect(
      designSpecNativeCurrencyForDispatch("gpt-5.5", "openai-responses"),
    ).toBe("CNY");
    expect(
      designSpecNativeCurrencyForDispatch(
        "claude-sonnet-5",
        "anthropic-messages",
      ),
    ).toBe("USD");

    budget.reserve({
      executionId: "design-spec:gpt-5-5:1",
      alias: "gpt-5.5",
      protocol: "openai-responses",
      maximumPicoUnits: "60",
    });
    budget.reserve({
      executionId: "design-spec:sonnet:1",
      alias: "claude-sonnet-5",
      protocol: "anthropic-messages",
      maximumPicoUnits: "150",
    });
    budget.settle({
      executionId: "design-spec:gpt-5-5:1",
      currency: "CNY",
      actualPicoUnits: "40",
    });

    expect(budget.snapshot()).toEqual({
      frozen: false,
      totalsByCurrency: {
        CNY: {
          capPicoUnits: "100",
          committedPicoUnits: "40",
          reservedPicoUnits: "0",
          remainingPicoUnits: "60",
        },
        USD: {
          capPicoUnits: "200",
          committedPicoUnits: "0",
          reservedPicoUnits: "150",
          remainingPicoUnits: "50",
        },
      },
    });
  });

  it("freezes on unknown, cross-currency, and over-cap settlement", () => {
    const unknown = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: "100",
      USD: "100",
    });
    unknown.reserve({
      executionId: "design-spec:terra:1",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      maximumPicoUnits: "50",
    });
    unknown.freezeUnknownSettlement("design-spec:terra:1");
    expect(unknown.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
    });
    expect(() =>
      unknown.reserve({
        executionId: "design-spec:terra:2",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        maximumPicoUnits: "1",
      }),
    ).toThrow("frozen");

    const crossCurrency = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: "100",
      USD: "100",
    });
    crossCurrency.reserve({
      executionId: "design-spec:terra:3",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      maximumPicoUnits: "50",
    });
    expect(() =>
      crossCurrency.settle({
        executionId: "design-spec:terra:3",
        currency: "USD",
        actualPicoUnits: "1",
      }),
    ).toThrow("currency");
    expect(crossCurrency.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "settlement_currency_mismatch",
    });

    const overCap = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: "100",
      USD: "100",
    });
    overCap.reserve({
      executionId: "design-spec:terra:4",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      maximumPicoUnits: "50",
    });
    expect(() =>
      overCap.settle({
        executionId: "design-spec:terra:4",
        currency: "CNY",
        actualPicoUnits: "51",
      }),
    ).toThrow("reservation");
    expect(overCap.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "settlement_exceeds_reservation",
    });
  });

  it("rejects unknown aliases and cap-overrun reservations before dispatch", () => {
    const budget = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: "100",
      USD: "100",
    });
    expect(() =>
      budget.reserve({
        executionId: "design-spec:invalid:1",
        alias: "minimax-m3",
        protocol: "openai-responses",
        maximumPicoUnits: "1",
      }),
    ).toThrow("not admitted");
    expect(() =>
      budget.reserve({
        executionId: "design-spec:terra:5",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        maximumPicoUnits: "101",
      }),
    ).toThrow("budget");
    expect(budget.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "native_budget_exhausted",
    });
  });

  it("rejects malformed values and duplicate execution identities", () => {
    expect(
      () =>
        new DesignSpecNativeCurrencyBudgetGuard({
          CNY: "0100",
          USD: "100",
        }),
    ).toThrow("canonical");

    const budget = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: "100",
      USD: "100",
    });
    expect(() =>
      budget.reserve({
        executionId: "short",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        maximumPicoUnits: "1",
      }),
    ).toThrow("execution id");
    budget.reserve({
      executionId: "design-spec:terra:valid",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      maximumPicoUnits: "1",
    });
    expect(() =>
      budget.reserve({
        executionId: "design-spec:terra:valid",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        maximumPicoUnits: "1",
      }),
    ).toThrow("already reserved");
    expect(() =>
      budget.settle({
        executionId: "design-spec:terra:valid",
        currency: "CNY",
        actualPicoUnits: "01",
      }),
    ).toThrow("canonical");
    expect(budget.snapshot()).toMatchObject({ frozen: false });
  });
});
