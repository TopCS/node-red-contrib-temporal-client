// temporal-workflow-starter.js
// Logica lato server per il nodo Node-RED "Temporal Workflow Starter".

// ATTENZIONE: Questo file NON deve essere eseguito direttamente con 'node temporal-workflow-starter.js'.
// È un modulo Node-RED e deve essere installato nella tua istanza Node-RED.
// Per installarlo:
// 1. Assicurati che la directory 'node-red-contrib-temporal-client' contenga questo file, il file .html e package.json.
// 2. Nella directory utente di Node-RED (solitamente ~/.node-red/), esegui:
//    npm install /percorso/alla/tua/cartella/node-red-contrib-temporal-client
// 3. Riavvia Node-RED.

const { Client, Connection } = require('@temporalio/client');

module.exports = function(RED) {
    // Funzione di logging strutturato per il nodo Node-RED.
    // Emette messaggi di log in formato JSON.
    function logStructured(node, level, message, metadata = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            message: message,
            service: 'node-red', // Il servizio è Node-RED stesso
            component: 'temporal-workflow-starter-node', // Componente specifico del nodo
            nodeId: node.id,       // ID del nodo
            nodeName: node.name || 'unnamed-node', // Nome del nodo
            flowId: node.z,        // ID del flusso
            ...metadata,
        };
        // Utilizza i metodi di logging di Node-RED per la compatibilità con il suo sistema di log
        if (level === 'error') {
            node.error(JSON.stringify(logEntry));
        } else if (level === 'warn') {
            node.warn(JSON.stringify(logEntry));
        } else {
            node.log(JSON.stringify(logEntry)); // node.log per info/debug
        }
    }

    // Verifica che l'ambiente RED sia disponibile. Se non lo è, significa che il file è stato eseguito direttamente.
    if (!RED || !RED.nodes || !RED.nodes.registerType) {
        console.error("\nERRORE: Questo file è un modulo Node-RED e non può essere eseguito direttamente.");
        console.error("Assicurati di installarlo correttamente nella tua istanza Node-RED.");
        console.error("Vedi i commenti all'inizio di questo file per le istruzioni di installazione.");
        return;
    }

    // Mappa per memorizzare le connessioni Temporal per ogni configurazione di nodo
    const connections = new Map();

    // Funzione helper per ottenere o creare una connessione Temporal persistente
    async function getOrCreateTemporalClient(config, node) {
        const connectionKey = `${config.serverAddress}-${config.namespace}`;

        if (connections.has(connectionKey)) {
            const { client, connection } = connections.get(connectionKey);
            // Verifica se la connessione è ancora valida
            if (connection && connection.ready) {
                return client;
            } else {
                logStructured(node, 'warn', `Connessione esistente non valida o chiusa per ${connectionKey}. Riconnessione...`, { connectionKey });
                // Pulisci la connessione non valida
                if (connection) {
                    try { connection.close(); } catch (e) { logStructured(node, 'warn', `Errore chiusura connessione non valida: ${e.message}`, { connectionKey, error: e.message }); }
                }
                connections.delete(connectionKey);
            }
        }

        // Crea una nuova connessione
        try {
            const connection = await Connection.connect({ address: config.serverAddress });
            const client = new Client({
                connection,
                namespace: config.namespace,
            });
            connections.set(connectionKey, { client, connection });
            logStructured(node, 'info', `Connesso a Temporal Server: ${config.serverAddress}, Namespace: ${config.namespace}`, { connectionKey, serverAddress: config.serverAddress, namespace: config.namespace });

            // Gestione degli eventi di disconnessione per pulizia
            // connection.on('close', (err) => {
            //     logStructured(node, 'warn', `Connessione chiusa per ${connectionKey}`, { connectionKey, error: err ? err.message : 'nessun errore' });
            //     connections.delete(connectionKey); // Rimuovi per forzare una riconnessione al prossimo utilizzo
            // });
            // connection.on('error', (err) => {
            //     logStructured(node, 'error', `Errore di connessione per ${connectionKey}`, { connectionKey, error: err.message, stack: err.stack });
            //     connections.delete(connectionKey); // Rimuovi per forzare una riconnessione al prossimo utilizzo
            // });

            return client;
        } catch (err) {
            logStructured(node, 'error', `Errore nella connessione al Temporal Server ${config.serverAddress}`, { serverAddress: config.serverAddress, error: err.message, stack: err.stack });
            throw err; // Rilancia l'errore per farlo gestire dal nodo
        }
    }

    // Definizione del nodo Node-RED
    function TemporalWorkflowStarterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Recupera le configurazioni dal nodo UI
        node.serverAddress = config.serverAddress;
        node.namespace = config.namespace;
        node.taskQueue = config.taskQueue;
        node.workflowName = config.workflowName;

        // Gestore per i messaggi in ingresso al nodo
        node.on('input', async function(msg, send, done) {
            node.status({ fill: "blue", shape: "dot", text: "avvio workflow..." });
            logStructured(node, 'info', 'Messaggio ricevuto, tentativo avvio workflow.', { msgId: msg._msgid });

            // Assicurati che il payload contenga gli argomenti per il workflow
            if (!msg.payload) {
                logStructured(node, 'error', "msg.payload non definito. Il payload dovrebbe contenere gli argomenti per il workflow Temporal.", { msgId: msg._msgid });
                node.status({ fill: "red", shape: "dot", text: "payload mancante" });
                done("msg.payload non definito.");
                return;
            }

            const workflowArgs = msg.payload; // Il payload in ingresso è l'argomento del workflow

            // Per il nostro caso d'uso, ci aspettiamo { sessionId: string }
            if (!workflowArgs.sessionId) {
                logStructured(node, 'error', "msg.payload.sessionId non definito. Richiesto per il workflow di riassunto.", { msgId: msg._msgid, payload: msg.payload });
                node.status({ fill: "red", shape: "dot", text: "sessionId mancante" });
                done("msg.payload.sessionId non definito.");
                return;
            }

            try {
                const temporalClient = await getOrCreateTemporalClient(node, node); // Passa 'node' per i log
                if (!temporalClient) {
                    throw new Error("Client Temporal non disponibile dopo il tentativo di connessione.");
                }

                // Genera un ID univoco per il workflow (basato su sessionId e timestamp)
                const workflowId = `summarize-${workflowArgs.sessionId.split('/').pop()}-${Date.now()}`;
                logStructured(node, 'info', 'Tentativo avvio workflow Temporal.', { msgId: msg._msgid, workflowId, workflowName: node.workflowName, taskQueue: node.taskQueue, sessionId: workflowArgs.sessionId });


                // Avvia il Workflow Temporal
                const workflowHandle = await temporalClient.workflow.start(node.workflowName, {
                    taskQueue: node.taskQueue,
                    workflowId: workflowId,
                    args: [workflowArgs], // Gli argomenti del workflow sono passati come array
                });

                logStructured(node, 'info', `Workflow avviato con successo.`, { msgId: msg._msgid, workflowName: node.workflowName, workflowId: workflowHandle.workflowId, runId: workflowHandle.runId });
                node.status({ fill: "green", shape: "dot", text: "workflow avviato" });

                // Invia un messaggio di output con i dettagli del workflow avviato
                msg.payload = {
                    status: "WorkflowStarted",
                    workflowId: workflowHandle.workflowId,
                    runId: workflowHandle.runId,
                    message: `Workflow ${node.workflowName} avviato con successo.`
                };
                send(msg); // Invia il messaggio al prossimo nodo nel flusso
                done(); // Segnala che il messaggio è stato elaborato

            } catch (error) {
                logStructured(node, 'error', `Errore nell'avvio del workflow: ${error.message}`, { msgId: msg._msgid, error: error.message, stack: error.stack, workflowArgs });
                node.status({ fill: "red", shape: "dot", text: "errore avvio workflow" });
                // Invia un messaggio di errore all'output del nodo
                msg.payload = {
                    status: "WorkflowStartFailed",
                    error: error.message,
                    details: error.stack
                };
                send(msg); // Invia il messaggio di errore
                done(error); // Segnala un errore a Node-RED
            }
        });

        // Gestore per la chiusura del nodo
        node.on('close', function(done) {
            // Non chiudiamo esplicitamente la connessione qui,
            // perché potrebbe essere condivisa con altre istanze del nodo.
            // La gestione della chiusura è implicita nella logica di getOrCreateTemporalClient
            // che rimuove le connessioni non valide.
            logStructured(node, 'info', 'Nodo chiuso.', { nodeId: node.id });
            done();
        });
    }

    // Registra il nodo in Node-RED
    RED.nodes.registerType("temporal-workflow-starter", TemporalWorkflowStarterNode);
};
