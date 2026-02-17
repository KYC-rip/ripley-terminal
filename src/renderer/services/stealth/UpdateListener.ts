import { MoneroWalletListener } from "monero-ts";
import { XmrStealthEngine } from "./XmrStealthEngine";

export class UpdateListener extends MoneroWalletListener {
  constructor(protected engine: XmrStealthEngine) { super(); };

  async onSyncProgress(height: number, startHeight: number, endHeight: number, percentDone: number, message: string) {
    this.engine.logger(`[UpdateListener] onSyncProgress: height=${height}, startHeight=${startHeight}, endHeight=${endHeight}, percentDone=${percentDone}, message=${message}`);
  }

  async onNewBlock(height: number) {
    this.engine.logger(`[UpdateListener] onNewBlock: height=${height}`);
  }

  async onBalancesChanged(newBalance: bigint, newUnlockedBalance: bigint) {
    this.engine.logger(`[UpdateListener] onBalancesChanged: newBalance=${newBalance}, newUnlockedBalance=${newUnlockedBalance}`);
  }

  async onOutputReceived(output: moneroTs.MoneroOutputWallet) {
    this.engine.logger(`[UpdateListener] onOutputReceived: output=${output}`);
  }

  async onOutputSpent(output: moneroTs.MoneroOutputWallet) {
    this.engine.logger(`[UpdateListener] onOutputSpent: output=${output}`);
  }
}