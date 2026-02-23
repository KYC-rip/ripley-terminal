// src/renderer/src/services/RpcClient.ts

export const RpcClient = {
  async call(method: string, params: any = {}): Promise<any> {
    const response = await window.api.proxyRequest({
      method,
      params
    });

    if (!response.success) {
      throw new Error(response.error || 'RPC_BRIDGE_FAILURE');
    }

    return response.result;
  },

  formatXmr(atomicUnits: number | string): string {
    return (Number(atomicUnits) / 1e12).toFixed(12).replace(/\.?0+$/, "");
  },

  toAtomic(xmr: number): number {
    return Math.floor(xmr * 1e12);
  }
};