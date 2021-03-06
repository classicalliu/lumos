import {
  Address,
  Cell,
  CellCollector as CellCollectorType,
  CellProvider,
  core,
  HexString,
  OutPoint,
  PackedSince,
  QueryOptions,
  Script,
  utils,
  values,
  WitnessArgs,
} from "@ckb-lumos/base";
import { Config, getConfig } from "@ckb-lumos/config-manager";
import {
  createTransactionFromSkeleton,
  generateAddress,
  minimalCellCapacity,
  Options,
  parseAddress,
  TransactionSkeletonType,
} from "@ckb-lumos/helpers";
import { normalizers, Reader } from "ckb-js-toolkit";
import { List, Set } from "immutable";
import { FromInfo, parseFromInfo } from "./from_info";
import {
  addCellDep,
  hashWitness,
  isAcpScript,
  SECP_SIGNATURE_PLACEHOLDER,
} from "./helper";
const { ScriptValue } = values;
const { CKBHasher, ckbHash, readBigUInt128LE } = utils;

export class CellCollector implements CellCollectorType {
  private cellCollector: CellCollectorType;
  private config: Config;
  public readonly fromScript: Script;

  constructor(
    fromInfo: FromInfo,
    cellProvider: CellProvider,
    {
      config = undefined,
      queryOptions = {},
    }: Options & {
      queryOptions?: QueryOptions;
    } = {}
  ) {
    if (!cellProvider) {
      throw new Error(`Cell provider is missing!`);
    }
    config = config || getConfig();
    this.fromScript = parseFromInfo(fromInfo, { config }).fromScript;

    this.config = config;

    queryOptions = {
      ...queryOptions,
      lock: this.fromScript,
      type: queryOptions.type || "empty",
    };

    this.cellCollector = cellProvider.collector(queryOptions);
  }

  async *collect(): AsyncGenerator<Cell> {
    if (!isAcpScript(this.fromScript, this.config)) {
      return;
    }
    for await (const inputCell of this.cellCollector.collect()) {
      yield inputCell;
    }
  }
}

export async function setupInputCell(
  txSkeleton: TransactionSkeletonType,
  inputCell: Cell,
  _fromInfo?: FromInfo,
  {
    config = undefined,
    defaultWitness = "0x",
    since = undefined,
  }: Options & {
    defaultWitness?: HexString;
    since?: PackedSince;
  } = {}
): Promise<TransactionSkeletonType> {
  config = config || getConfig();

  const inputLock: Script = inputCell.cell_output.lock;
  if (!isAcpScript(inputLock, config)) {
    throw new Error("Not anyone-can-pay input!");
  }

  // add inputCell to txSkeleton
  txSkeleton = txSkeleton.update("inputs", (inputs) => {
    return inputs.push(inputCell);
  });

  if (since) {
    txSkeleton = txSkeleton.update("inputSinces", (inputSinces) => {
      return inputSinces.set(txSkeleton.get("inputs").size - 1, since);
    });
  }

  txSkeleton = txSkeleton.update("witnesses", (witnesses) => {
    return witnesses.push(defaultWitness);
  });

  const outputCell: Cell = {
    cell_output: {
      capacity: inputCell.cell_output.capacity,
      lock: inputCell.cell_output.lock,
      type: inputCell.cell_output.type,
    },
    data: inputCell.data,
  };

  txSkeleton = txSkeleton.update("outputs", (outputs) => {
    return outputs.push(outputCell);
  });

  txSkeleton = txSkeleton.update("fixedEntries", (fixedEntries) => {
    return fixedEntries.push({
      field: "outputs",
      index: txSkeleton.get("outputs").size - 1,
    });
  });

  const template = config.SCRIPTS.ANYONE_CAN_PAY;
  if (!template) {
    throw new Error(`ANYONE_CAN_PAY script not defined in config!`);
  }

  const scriptOutPoint: OutPoint = {
    tx_hash: template.TX_HASH,
    index: template.INDEX,
  };

  // add cell_dep
  txSkeleton = addCellDep(txSkeleton, {
    out_point: scriptOutPoint,
    dep_type: template.DEP_TYPE,
  });

  // add witness
  const firstIndex = txSkeleton.get("inputs").findIndex((input) => {
    return new ScriptValue(input.cell_output.lock, { validate: false }).equals(
      new ScriptValue(inputLock, { validate: false })
    );
  });
  if (firstIndex !== -1) {
    while (firstIndex >= txSkeleton.get("witnesses").size) {
      txSkeleton = txSkeleton.update("witnesses", (witnesses) => {
        return witnesses.push("0x");
      });
    }
    let witness: HexString = txSkeleton.get("witnesses").get(firstIndex)!;
    const newWitnessArgs: WitnessArgs = {
      /* 65-byte zeros in hex */
      lock: SECP_SIGNATURE_PLACEHOLDER,
    };
    if (witness !== "0x") {
      const witnessArgs = new core.WitnessArgs(new Reader(witness));
      const lock = witnessArgs.getLock();
      if (
        lock.hasValue() &&
        new Reader(lock.value().raw()).serializeJson() !== newWitnessArgs.lock
      ) {
        throw new Error(
          "Lock field in first witness is set aside for signature!"
        );
      }
      const inputType = witnessArgs.getInputType();
      if (inputType.hasValue()) {
        newWitnessArgs.input_type = new Reader(
          inputType.value().raw()
        ).serializeJson();
      }
      const outputType = witnessArgs.getOutputType();
      if (outputType.hasValue()) {
        newWitnessArgs.output_type = new Reader(
          outputType.value().raw()
        ).serializeJson();
      }
    }
    witness = new Reader(
      core.SerializeWitnessArgs(
        normalizers.NormalizeWitnessArgs(newWitnessArgs)
      )
    ).serializeJson();
    txSkeleton = txSkeleton.update("witnesses", (witnesses) => {
      return witnesses.set(firstIndex, witness);
    });
  }

  return txSkeleton;
}

// export for tests
export function checkLimit(acpArgs: HexString, capacity: bigint): void {
  let minimalAmount: bigint | undefined;
  let minimalCapacity: bigint | undefined;
  if (acpArgs.length >= 46) {
    minimalAmount = 10n ** BigInt("0x" + acpArgs.slice(44, 46));
  }
  if (acpArgs.length >= 44) {
    // should convert to shannons
    minimalCapacity = 10n ** BigInt("0x" + acpArgs.slice(42, 44)) * 10n ** 8n;
  }
  // Both minimalAmount & minimalCapacity OR only minimalCapacity
  if (minimalCapacity && minimalAmount) {
    if (capacity < minimalCapacity) {
      throw new Error(
        `capacity(${capacity}) less than toAddress minimal capacity limit(${minimalCapacity}), and amount less then toAddress minimal amount limit(${minimalAmount})! If you want to transfer sudt, maybe sudt.transfer can help you.`
      );
    }
  } else if (minimalCapacity) {
    if (capacity < minimalCapacity) {
      throw new Error(
        `capacity(${capacity}) less than toAddress minimal capacity limit(${minimalCapacity})!`
      );
    }
  }
}

export async function setupOutputCell(
  txSkeleton: TransactionSkeletonType,
  outputCell: Cell,
  { config = undefined }: Options = {}
): Promise<TransactionSkeletonType> {
  config = config || getConfig();

  const toScript: Script = outputCell.cell_output.lock;

  const capacity: bigint = BigInt(outputCell.cell_output.capacity);

  checkLimit(toScript.args, capacity);

  const cellProvider = txSkeleton.get("cellProvider");
  if (!cellProvider) {
    throw new Error(`Cell Provider is missing!`);
  }

  const toAddress: Address = generateAddress(toScript, { config });
  const toAddressCellCollector = new CellCollector(toAddress, cellProvider, {
    config,
  });

  const toAddressInput: Cell | void = (
    await toAddressCellCollector.collect().next()
  ).value;
  if (!toAddressInput) {
    throw new Error(`toAddress ANYONE_CAN_PAY input not found!`);
  }

  const outputCapacity: bigint =
    capacity + BigInt(toAddressInput.cell_output.capacity);
  outputCell.cell_output.capacity = "0x" + outputCapacity.toString(16);

  txSkeleton = txSkeleton.update("outputs", (outputs) => {
    return outputs.push(outputCell);
  });
  txSkeleton = txSkeleton.update("inputs", (inputs) => {
    return inputs.push(toAddressInput);
  });
  txSkeleton = txSkeleton.update("witnesses", (witnesses) => {
    return witnesses.push("0x");
  });

  const template = config.SCRIPTS.ANYONE_CAN_PAY;
  if (!template) {
    throw new Error(`ANYONE_CAN_PAY script not defined in config!`);
  }

  const scriptOutPoint: OutPoint = {
    tx_hash: template.TX_HASH,
    index: template.INDEX,
  };

  // add cell_dep
  txSkeleton = addCellDep(txSkeleton, {
    out_point: scriptOutPoint,
    dep_type: template.DEP_TYPE,
  });

  return txSkeleton;
}

export async function injectCapacity(
  cellCollector: CellCollector,
  txSkeleton: TransactionSkeletonType,
  outputIndex: number,
  capacity: bigint,
  { config = undefined }: Options = {}
): Promise<TransactionSkeletonType> {
  config = config || getConfig();

  if (outputIndex >= txSkeleton.get("outputs").size) {
    throw new Error(`Invalid output index!`);
  }

  capacity = BigInt(capacity);

  const template = config.SCRIPTS.ANYONE_CAN_PAY;
  if (!template) {
    throw new Error(
      `Provided config does not have ANYONE_CAN_PAY script setup!`
    );
  }

  const fromScript: Script = cellCollector.fromScript;

  /*
   * First, check if there is any output cells that contains enough capacity
   * for us to tinker with.
   *
   * TODO: the solution right now won't cover all cases, some outputs before the
   * last output might still be tinkerable, right now we are working on the
   * simple solution, later we can change this for more optimizations.
   */
  const lastFreezedOutput = txSkeleton
    .get("fixedEntries")
    .filter(({ field }) => field === "outputs")
    .maxBy(({ index }) => index);
  let i = lastFreezedOutput ? lastFreezedOutput.index + 1 : 0;
  for (; i < txSkeleton.get("outputs").size && capacity > 0; i++) {
    const output = txSkeleton.get("outputs").get(i)!;
    if (
      new ScriptValue(output.cell_output.lock, { validate: false }).equals(
        new ScriptValue(fromScript, { validate: false })
      )
    ) {
      const cellCapacity: bigint = BigInt(output.cell_output.capacity);
      const availableCapacity: bigint =
        cellCapacity - minimalCellCapacity(output);
      // should maintain minimal cell capcity in anyone-can-pay output
      const deductCapacity: bigint =
        capacity >= availableCapacity ? availableCapacity : capacity;
      capacity -= deductCapacity;
      output.cell_output.capacity =
        "0x" + (cellCapacity - deductCapacity).toString(16);
    }
  }
  // Remove all output cells with capacity equal to 0
  txSkeleton = txSkeleton.update("outputs", (outputs) => {
    return outputs.filter(
      (output) => BigInt(output.cell_output.capacity) !== BigInt(0)
    );
  });

  const getInputKey = (input: Cell) =>
    `${input.out_point!.tx_hash}_${input.out_point!.index}`;
  if (capacity > 0n) {
    const changeCell: Cell = {
      cell_output: {
        capacity: "0x0",
        lock: fromScript,
        type: undefined,
      },
      data: "0x",
      out_point: undefined,
      block_hash: undefined,
    };
    let changeCapacity = 0n;
    const minimalChangeCapacity: bigint = minimalCellCapacity(changeCell);

    let previousInputs = Set<string>();
    for (const input of txSkeleton.get("inputs")) {
      previousInputs = previousInputs.add(getInputKey(input));
    }

    // Are all from same lock script and type script, so only need one change cell
    for await (const inputCell of cellCollector.collect()) {
      if (previousInputs.has(getInputKey(inputCell))) {
        continue;
      }

      txSkeleton = await setupInputCell(txSkeleton, inputCell, undefined, {
        config,
      });
      const lastOutputIndex: number = txSkeleton.get("outputs").size - 1;
      txSkeleton = txSkeleton.update("outputs", (outputs) => {
        return outputs.remove(lastOutputIndex);
      });
      const fixedEntryIndex: number = txSkeleton
        .get("fixedEntries")
        .findIndex((fixedEntry) => {
          return (
            fixedEntry.field === "outputs" &&
            fixedEntry.index === lastOutputIndex
          );
        });
      if (fixedEntryIndex >= 0) {
        txSkeleton = txSkeleton.update("fixedEntries", (fixedEntries) => {
          return fixedEntries.remove(fixedEntryIndex);
        });
      }

      const inputCapacity = BigInt(inputCell.cell_output.capacity);
      let deductCapacity = inputCapacity;
      if (deductCapacity > capacity) {
        deductCapacity = capacity;
      }
      capacity -= deductCapacity;
      changeCapacity += inputCapacity - deductCapacity;
      if (capacity === 0n && changeCapacity >= minimalChangeCapacity) {
        break;
      }

      changeCell.cell_output.capacity = "0x" + changeCapacity.toString(16);
      txSkeleton = txSkeleton.update("outputs", (outputs) => {
        return outputs.push(changeCell);
      });
    }

    if (capacity > 0n || changeCapacity < minimalChangeCapacity) {
      throw new Error(`Not enough capacity in from address!`);
    }

    changeCell.cell_output.capacity = "0x" + changeCapacity.toString(16);
    txSkeleton = txSkeleton.update("outputs", (outputs) => {
      return outputs.push(changeCell);
    });
  }

  return txSkeleton;
}

export function prepareSigningEntries(
  txSkeleton: TransactionSkeletonType,
  { config = undefined }: Options = {}
): TransactionSkeletonType {
  config = config || getConfig();

  const scriptType = "ANYONE_CAN_PAY";
  const template = config.SCRIPTS[scriptType];
  if (!template) {
    throw new Error(
      `Provided config does not have ${scriptType} script setup!`
    );
  }

  let processedArgs = Set<string>();
  const tx = createTransactionFromSkeleton(txSkeleton);
  const txHash = ckbHash(
    core.SerializeRawTransaction(normalizers.NormalizeRawTransaction(tx))
  ).serializeJson();
  const inputs = txSkeleton.get("inputs");
  const witnesses = txSkeleton.get("witnesses");
  let signingEntries = txSkeleton.get("signingEntries");
  for (let i = 0; i < inputs.size; i++) {
    const input = inputs.get(i)!;
    if (
      template.CODE_HASH === input.cell_output.lock.code_hash &&
      template.HASH_TYPE === input.cell_output.lock.hash_type &&
      !processedArgs.has(input.cell_output.lock.args)
    ) {
      processedArgs = processedArgs.add(input.cell_output.lock.args);

      // skip if input sum capcity <= output sum capacity
      // and input sum amount <= output sum amount
      const outputs: List<Cell> = txSkeleton.get("outputs").filter((output) => {
        return new ScriptValue(output.cell_output.lock, {
          validate: false,
        }).equals(new ScriptValue(input.cell_output.lock, { validate: false }));
      });
      const sumOfOutputCapacity: bigint = outputs
        .map((output) => BigInt(output.cell_output.capacity))
        .reduce((result, c) => result + c, 0n);

      const sumOfOutputAmount: bigint = outputs
        .filter((output) => output.data !== "0x")
        .map((output) => readBigUInt128LE(output.data))
        .reduce((result, c) => result + c, 0n);

      const fInputs: List<Cell> = inputs.filter((i) => {
        return new ScriptValue(i.cell_output.lock, { validate: false }).equals(
          new ScriptValue(input.cell_output.lock, { validate: false })
        );
      });

      const sumOfInputCapacity: bigint = fInputs
        .map((i) => BigInt(i.cell_output.capacity))
        .reduce((result, c) => result + c, 0n);

      const sumOfInputAmount: bigint = fInputs
        .filter((i) => i.data !== "0x")
        .map((i) => readBigUInt128LE(i.data))
        .reduce((result, c) => result + c, 0n);

      if (
        sumOfInputCapacity <= sumOfOutputCapacity &&
        sumOfInputAmount <= sumOfOutputAmount
      ) {
        continue;
      }

      const lockValue = new values.ScriptValue(input.cell_output.lock, {
        validate: false,
      });
      const hasher = new CKBHasher();
      hasher.update(txHash);
      if (i >= witnesses.size) {
        throw new Error(
          `The first witness in the script group starting at input index ${i} does not exist, maybe some other part has invalidly tampered the transaction?`
        );
      }
      hashWitness(hasher, witnesses.get(i)!);
      for (let j = i + 1; j < inputs.size && j < witnesses.size; j++) {
        const otherInput = inputs.get(j)!;
        if (
          lockValue.equals(
            new values.ScriptValue(otherInput.cell_output.lock, {
              validate: false,
            })
          )
        ) {
          hashWitness(hasher, witnesses.get(j)!);
        }
      }
      for (let j = inputs.size; j < witnesses.size; j++) {
        hashWitness(hasher, witnesses.get(j)!);
      }
      const signingEntry = {
        type: "witness_args_lock",
        index: i,
        message: hasher.digestHex(),
      };
      signingEntries = signingEntries.push(signingEntry);
    }
  }
  txSkeleton = txSkeleton.set("signingEntries", signingEntries);
  return txSkeleton;
}

export async function withdraw(
  txSkeleton: TransactionSkeletonType,
  fromInput: Cell,
  toAddress: Address,
  capacity: bigint,
  { config = undefined }: Options = {}
): Promise<TransactionSkeletonType> {
  config = config || getConfig();

  // from input must be a anyone-can-pay script
  if (!isAcpScript(fromInput.cell_output.lock, config)) {
    throw new Error(`fromInput is not a ANYONE_CAN_PAY cell!`);
  }

  // check capacity
  capacity = BigInt(capacity);
  const fromInputCapacity: bigint = BigInt(fromInput.cell_output.capacity);
  const inputMinimalCellCapacity: bigint = minimalCellCapacity(fromInput);
  if (
    !(
      (capacity >= 0n &&
        capacity <= fromInputCapacity - inputMinimalCellCapacity) ||
      capacity === fromInputCapacity
    )
  ) {
    throw new Error(
      `capacity must be in [0, ${
        fromInputCapacity - inputMinimalCellCapacity
      }] or ${fromInputCapacity} !`
    );
  }

  const toScript = parseAddress(toAddress, { config });

  const targetOutput: Cell = {
    cell_output: {
      capacity: "0x" + capacity.toString(16),
      lock: toScript,
      type: undefined,
    },
    data: "0x",
    out_point: undefined,
    block_hash: undefined,
  };

  if (isAcpScript(toScript, config)) {
    checkLimit(toScript.args, capacity);

    const cellProvider = txSkeleton.get("cellProvider");
    if (!cellProvider) {
      throw new Error(`Cell Provider is missing!`);
    }

    const toAddressCellCollector = new CellCollector(toAddress, cellProvider, {
      config,
    });

    const toAddressInput: Cell | void = (
      await toAddressCellCollector.collect().next()
    ).value;
    if (!toAddressInput) {
      throw new Error(`toAddress ANYONE_CAN_PAY input not found!`);
    }

    const outputCapacity: bigint =
      BigInt(capacity) + BigInt(toAddressInput.cell_output.capacity);
    targetOutput.cell_output.capacity = "0x" + outputCapacity.toString(16);

    txSkeleton = txSkeleton.update("inputs", (inputs) => {
      return inputs.push(toAddressInput);
    });
    txSkeleton = txSkeleton.update("witnesses", (witnesses) => {
      return witnesses.push("0x");
    });
  }

  txSkeleton = txSkeleton.update("outputs", (outputs) => {
    return outputs.push(targetOutput);
  });

  txSkeleton = await setupInputCell(
    txSkeleton,
    fromInput,
    generateAddress(fromInput.cell_output.lock, { config }),
    { config }
  );
  // remove output and fixedEntry added by `setupInputCell`
  const lastOutputIndex: number = txSkeleton.get("outputs").size - 1;
  txSkeleton = txSkeleton.update("outputs", (outputs) => {
    return outputs.remove(lastOutputIndex);
  });
  const fixedEntryIndex: number = txSkeleton
    .get("fixedEntries")
    .findIndex((fixedEntry) => {
      return (
        fixedEntry.field === "outputs" && fixedEntry.index === lastOutputIndex
      );
    });
  if (fixedEntryIndex >= 0) {
    txSkeleton = txSkeleton.update("fixedEntries", (fixedEntries) => {
      return fixedEntries.remove(fixedEntryIndex);
    });
  }

  if (capacity !== fromInputCapacity) {
    txSkeleton = txSkeleton.update("outputs", (outputs) => {
      return outputs.push({
        cell_output: {
          capacity: "0x" + (fromInputCapacity - capacity).toString(16),
          lock: fromInput.cell_output.lock,
          type: fromInput.cell_output.type,
        },
        data: fromInput.data,
      });
    });
  }

  return txSkeleton;
}

export default {
  CellCollector,
  setupInputCell,
  setupOutputCell,
  injectCapacity,
  prepareSigningEntries,
  withdraw,
};
