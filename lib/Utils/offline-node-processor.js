"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeOfflineNodeProcessor = void 0;

/**
 * Creates a processor for offline stanza nodes that:
 * - Queues nodes for sequential processing
 * - Yields to the event loop periodically to avoid blocking
 * - Catches handler errors to prevent the processing loop from crashing
 */
function makeOfflineNodeProcessor(nodeProcessorMap, deps, batchSize = 10) {
    const nodes = [];
    let isProcessing = false;

    const enqueue = (type, node) => {
        nodes.push({ type, node });

        if (isProcessing) {
            return;
        }

        isProcessing = true;

        const promise = async () => {
            let processedInBatch = 0;

            while (nodes.length && deps.isWsOpen()) {
                const { type: t, node: n } = nodes.shift();

                const nodeProcessor = nodeProcessorMap.get(t);

                if (!nodeProcessor) {
                    deps.onUnexpectedError(new Error(`unknown offline node type: ${t}`), 'processing offline node');
                    continue;
                }

                await nodeProcessor(n).catch(err => deps.onUnexpectedError(err, `processing offline ${t}`));
                processedInBatch++;

                // Yield to event loop after processing a batch to prevent blocking
                if (processedInBatch >= batchSize) {
                    processedInBatch = 0;
                    await deps.yieldToEventLoop();
                }
            }

            isProcessing = false;
        };

        promise().catch(error => deps.onUnexpectedError(error, 'processing offline nodes'));
    };

    return { enqueue };
}
exports.makeOfflineNodeProcessor = makeOfflineNodeProcessor;
