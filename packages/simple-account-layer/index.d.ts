import {
  OutPoint,
  Script,
  Transaction,
} from "@ckb-lumos/base/lib/core";
import { TransactionSkeletonType } from "@ckb-lumos/helpers";
export interface CkbSimpleAccountConfig {
  validator: ArrayBuffer;
  generator: ArrayBuffer;
  validatorOutpoint: OutPoint;
  typeScript: Script;
  lockScript?: Script;
  capacity: number;
}

export interface SparseMerkleTree {
  rootHash: ArrayBuffer;
  leaves: Object;
  branches: Object;
}

export declare class CkbSimpleAccount {
  constructor(config: CkbSimpleAccountConfig);

  generate(program: ArrayBuffer): TransactionSkeletonType;

  advance(transaction: Transaction): void;

  restoreFromTransactions(
    config: CkbSimpleAccountConfig,
    transactions: Array<Transaction>,
    consumeAllTransactions: boolean
  ): void;
}
