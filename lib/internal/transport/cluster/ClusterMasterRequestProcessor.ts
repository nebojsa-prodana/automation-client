import * as cluster from "cluster";
import { StatsD } from "hot-shots";
import * as stringify from "json-stringify-safe";
import * as TinyQueue from "tinyqueue";
import * as WebSocket from "ws";
import { Configuration } from "../../../configuration";
import { EventFired } from "../../../HandleEvent";
import {
    AutomationContextAware,
    HandlerContext,
} from "../../../HandlerContext";
import { HandlerResult } from "../../../HandlerResult";
import { AutomationEventListener } from "../../../server/AutomationEventListener";
import { AutomationServer } from "../../../server/AutomationServer";
import { GraphClient } from "../../../spi/graph/GraphClient";
import { MessageClient } from "../../../spi/message/MessageClient";
import { printError } from "../../../util/error";
import { logger } from "../../../util/logger";
import { CommandInvocation } from "../../invoker/Payload";
import * as namespace from "../../util/cls";
import { Deferred } from "../../util/Deferred";
import {
    HealthStatus,
    registerHealthIndicator,
} from "../../util/health";
import { registerShutdownHook } from "../../util/shutdown";
import { AbstractRequestProcessor } from "../AbstractRequestProcessor";
import {
    CommandIncoming,
    EventIncoming,
    isCommandIncoming,
    isEventIncoming,
} from "../RequestProcessor";
import { WebSocketLifecycle } from "../websocket/WebSocketLifecycle";
import {
    WebSocketCommandMessageClient,
    WebSocketEventMessageClient,
} from "../websocket/WebSocketMessageClient";
import {
    RegistrationConfirmation,
    WebSocketRequestProcessor,
} from "../websocket/WebSocketRequestProcessor";
import {
    broadcast,
    MasterMessage,
    WorkerMessage,
} from "./messages";

interface MessageType {
    message: MasterMessage;
    dispatched: Dispatched<any>;
    ts: number;
}

/**
 * A RequestProcessor that delegates to Node.JS Cluster workers to do the actual
 * command and event processing.
 * @see ClusterWorkerRequestProcessor
 */
export class ClusterMasterRequestProcessor extends AbstractRequestProcessor
    implements WebSocketRequestProcessor {

    private registration?: RegistrationConfirmation;
    private webSocketLifecycle: WebSocketLifecycle;
    private commands: Map<string, { dispatched: Dispatched<HandlerResult>, worker: number }> = new Map();
    private events: Map<string, { dispatched: Dispatched<HandlerResult[]>, worker: number }> = new Map();
    private messages: TinyQueue<MessageType> = new TinyQueue([], (a: MessageType, b: MessageType) => {
        if (a.message.type === "atomist:command" && b.message.type !== "atomist:command") {
            return -1;
        } else if (a.message.type !== "atomist:command" && b.message.type === "atomist:command") {
            return 1;
        } else {
            return a.ts - b.ts;
        }
    });
    private shutdownInitiated: boolean = false;

    constructor(protected automations: AutomationServer,
                protected configuration: Configuration,
                protected listeners: AutomationEventListener[] = [],
                protected numWorkers: number = require("os").cpus().length,
                protected maxConcurrentPerWorker: number = 4) {
        super(automations, configuration, listeners);
        this.webSocketLifecycle = (configuration.ws as any).lifecycle as WebSocketLifecycle;

        registerHealthIndicator(() => {
            const cmds: string[] = [];
            for (const key of this.commands.keys()) {
                cmds.push(key);
            }

            const evts: string[] = [];
            for (const key of this.events.keys()) {
                evts.push(key);
            }

            if (this.webSocketLifecycle.connected() && this.registration) {
                return {
                    status: HealthStatus.Up,
                    detail: {
                        commands: cmds,
                        events: evts,
                    },
                };
            } else {
                return {
                    status: HealthStatus.Down,
                    detail: {
                        commands: cmds,
                        events: evts,
                    },
                };
            }
        });

        registerShutdownHook(() => {
            this.shutdownInitiated = true;
            return Promise.resolve(0);
        }, Number.MIN_VALUE);

        this.scheduleQueueLength();
    }

    public onRegistration(registration: RegistrationConfirmation) {
        logger.info("Registration successful: %s", stringify(registration));
        (this.configuration.ws as any).session = registration;
        this.registration = registration;

        broadcast({
            type: "atomist:registration",
            registration: this.registration,
            context: null,
        });
    }

    public onConnect(ws: WebSocket) {
        logger.info("WebSocket connection established. Listening for incoming messages");
        this.webSocketLifecycle.set(ws);
        this.listeners.forEach(l => l.registrationSuccessful(this));
    }

    public onDisconnect() {
        this.webSocketLifecycle.reset();
        this.registration = null;
    }

    public run(): Promise<any> {
        const ws = () => this.webSocketLifecycle;

        const attachEvents = (worker: cluster.Worker, deferred: Deferred<any>) => {
            worker.on("message", message => {
                const msg = message as WorkerMessage;

                // Wait for online message to come in
                if (msg.type === "atomist:online") {
                    deferred.resolve();
                    return;
                }

                const ses = namespace.create();
                ses.run(() => {
                    // Only process our messages
                    if (!msg.type || (msg.type && !msg.type.startsWith("atomist:"))) {
                        return;
                    }

                    namespace.set(msg.context);

                    logger.debug("Received '%s' message from worker '%s': %j", msg.type, worker.id, msg.context);

                    const invocationId = namespace.get().invocationId;
                    const ctx = hydrateContext(msg);
                    if (msg.type === "atomist:message") {

                        let messageClient: MessageClient;
                        if (this.commands.has(invocationId)) {
                            messageClient = this.commands.get(invocationId).dispatched.context.messageClient;
                        } else if (this.events.has(invocationId)) {
                            messageClient = this.events.get(invocationId).dispatched.context.messageClient;
                        } else {
                            logger.error("Can't handle message from worker due to missing messageClient");
                            this.clearNamespace();
                            return;
                        }

                        if (msg.data.destinations && msg.data.destinations.length > 0) {
                            messageClient.send(msg.data.message, msg.data.destinations, msg.data.options)
                                .then(this.clearNamespace, this.clearNamespace);
                        } else {
                            messageClient.respond(msg.data.message, msg.data.options)
                                .then(this.clearNamespace, this.clearNamespace);
                        }
                    } else if (msg.type === "atomist:status") {
                        ws().send(msg.data);
                    } else if (msg.type === "atomist:command_success") {
                        this.listeners.map(l => () => l.commandSuccessful(msg.event as CommandInvocation,
                            ctx, msg.data as HandlerResult))
                            .reduce((p, f) => p.then(f), Promise.resolve())
                            .then(() => {
                                if (this.commands.has(invocationId)) {
                                    this.commands.get(invocationId).dispatched.result.resolve(msg.data as HandlerResult);
                                    this.commands.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            })
                            .catch(e => {
                                logger.warn(`Failed to run listeners: ${e.message}`);
                                printError(e);
                                if (this.commands.has(invocationId)) {
                                    this.commands.get(invocationId).dispatched.result.resolve(msg.data as HandlerResult);
                                    this.commands.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            });
                    } else if (msg.type === "atomist:command_failure") {
                        this.listeners.map(l => () => l.commandFailed(msg.event as CommandInvocation,
                            ctx, msg.data as HandlerResult))
                            .reduce((p, f) => p.then(f), Promise.resolve())
                            .then(() => {
                                if (this.commands.has(invocationId)) {
                                    this.commands.get(invocationId).dispatched.result.reject(msg.data as HandlerResult);
                                    this.commands.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            })
                            .catch(e => {
                                logger.warn(`Failed to run listeners: ${e.message}`);
                                printError(e);
                                if (this.commands.has(invocationId)) {
                                    this.commands.get(invocationId).dispatched.result.reject(msg.data as HandlerResult);
                                    this.commands.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            });
                    } else if (msg.type === "atomist:event_success") {
                        this.listeners.map(l => () => l.eventSuccessful(msg.event as EventFired<any>,
                            ctx, msg.data as HandlerResult[]))
                            .reduce((p, f) => p.then(f), Promise.resolve())
                            .then(() => {
                                if (this.events.has(invocationId)) {
                                    this.events.get(invocationId).dispatched.result.resolve(msg.data as HandlerResult[]);
                                    this.events.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            })
                            .catch(e => {
                                logger.warn(`Failed to run listeners: ${e.message}`);
                                printError(e);
                                if (this.events.has(invocationId)) {
                                    this.events.get(invocationId).dispatched.result.resolve(msg.data as HandlerResult);
                                    this.events.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            });
                    } else if (msg.type === "atomist:event_failure") {
                        this.listeners.map(l => () => l.eventFailed(msg.event as EventFired<any>,
                            ctx, msg.data as HandlerResult[]))
                            .reduce((p, f) => p.then(f), Promise.resolve())
                            .then(() => {
                                if (this.events.has(invocationId)) {
                                    this.events.get(invocationId).dispatched.result.reject(msg.data as HandlerResult[]);
                                    this.events.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            })
                            .catch(e => {
                                logger.warn(`Failed to run listeners: ${e.message}`);
                                printError(e);
                                if (this.events.has(invocationId)) {
                                    this.events.get(invocationId).dispatched.result.reject(msg.data as HandlerResult);
                                    this.events.delete(invocationId);
                                }
                                this.clearNamespace();
                                this.startMessage();
                            });
                    } else if (msg.type === "atomist:shutdown") {
                        logger.info(`Shutdown requested from worker`);
                        process.exit(msg.data);
                    }
                });
            });
        };
        attachEvents.bind(this);

        const promises: Array<Promise<any>> = [];

        for (let i = 0; i < this.numWorkers; i++) {
            const worker = cluster.fork();

            const deferred = new Deferred<any>();
            promises.push(deferred.promise);

            attachEvents(worker, deferred);
        }

        cluster.on("disconnect", worker => {
            logger.warn(`Worker '${worker.id}' disconnected`);
        });

        cluster.on("online", worker => {
            logger.debug(`Worker '${worker.id}' connected`);
            this.startMessage();
        });

        cluster.on("exit", (worker, code, signal) => {
            if (code !== 0 && !this.shutdownInitiated) {
                logger.warn(`Worker '${worker.id}' exited with '${code}' '${signal}'. Restarting ...`);
                attachEvents(cluster.fork(), new Deferred());
            }
        });

        return Promise.all(promises);
    }

    protected invokeCommand(ci: CommandInvocation,
                            ctx: HandlerContext & AutomationContextAware,
                            command: CommandIncoming,
                            callback: (result: Promise<HandlerResult>) => void) {
        const message: MasterMessage = {
            type: "atomist:command",
            registration: this.registration,
            context: ctx.context,
            data: command,
        };

        const dispatched = new Dispatched(new Deferred<HandlerResult>(), ctx);
        this.messages.push({ message, dispatched, ts: new Date().getTime() });
        callback(dispatched.result.promise);

        this.startMessage();
    }

    protected invokeEvent(ef: EventFired<any>,
                          ctx: HandlerContext & AutomationContextAware,
                          event: EventIncoming,
                          callback: (results: Promise<HandlerResult[]>) => void) {
        const message: MasterMessage = {
            type: "atomist:event",
            registration: this.registration,
            context: ctx.context,
            data: event,
        };

        const dispatched = new Dispatched(new Deferred<HandlerResult[]>(), ctx);
        this.messages.push({ message, dispatched, ts: new Date().getTime() });
        callback(dispatched.result.promise);

        this.startMessage();
    }

    protected sendStatusMessage(payload: any, ctx: HandlerContext & AutomationContextAware): Promise<any> {
        return Promise.resolve(
            this.webSocketLifecycle.send(payload),
        );
    }

    protected createGraphClient(event: CommandIncoming | EventIncoming): GraphClient {
        return null;
    }

    protected createMessageClient(event: CommandIncoming | EventIncoming): MessageClient {
        if (isCommandIncoming(event)) {
            return new WebSocketCommandMessageClient(event, this.webSocketLifecycle, this.configuration);
        } else if (isEventIncoming(event)) {
            return new WebSocketEventMessageClient(event, this.webSocketLifecycle, this.configuration);
        }
    }

    private assignWorker(): cluster.Worker | undefined {
        let workers: Array<{ worker: cluster.Worker, messages: number }> = [];
        for (const id in cluster.workers) {
            if (cluster.workers.hasOwnProperty(id)) {
                const worker = cluster.workers[id];
                if (worker.isConnected) {
                    workers.push({ worker, messages: 0 });
                }
            }
        }

        const deadEvents = [];
        this.events.forEach((e, k) => {
            const worker = workers.find(w => w.worker.id === e.worker);
            if (!!worker) {
                worker.messages = worker.messages + 1;
            } else {
                deadEvents.push(k);
            }
        });
        deadEvents.forEach(de => this.events.delete(de));

        const deadCommands = [];
        this.commands.forEach((c, k) => {
            const worker = workers.find(w => w.worker.id === c.worker);
            if (!!worker) {
                worker.messages = worker.messages + 1;
            } else {
                deadCommands.push(k);
            }
        });
        deadCommands.forEach(dc => this.commands.delete(dc));

        workers = workers.filter(w => w.messages < this.maxConcurrentPerWorker);
        if (workers.length === 0) {
            return undefined;
        }
        return workers[Math.floor(Math.random() * workers.length)].worker;
    }

    private startMessage(): void {
        if (this.messages.length > 0) {
            const worker = this.assignWorker();
            if (!!worker) {
                const message = this.messages.pop();
                namespace.set(message.message.context);
                if (message.message.type === "atomist:command") {
                    this.commands.set(message.message.context.invocationId, {
                        dispatched: message.dispatched,
                        worker: worker.id,
                    });
                    logger.debug(
                        "Incoming command handler request '%s' dispatching to worker '%s'",
                        message.message.data.command,
                        worker.id);
                } else if (message.message.type === "atomist:event") {
                    this.events.set(message.message.context.invocationId, {
                        dispatched: message.dispatched,
                        worker: worker.id,
                    });
                    logger.debug(
                        "Incoming event handler subscription '%s' dispatching to worker '%s'",
                        message.message.data.extensions.operationName,
                        worker.id);
                }
                worker.send(message.message);
            }
        }
        this.reportQueueLength();
    }

    private scheduleQueueLength(): void {
        if (this.configuration.statsd.enabled) {
            setInterval(() => {
                this.reportQueueLength();
            }, 1000).unref();
        }
    }

    private reportQueueLength(): void {
        if (this.configuration.statsd.enabled) {
            const statsd = (this.configuration.statsd as any).__instance as StatsD;
            if (!!statsd) {
                statsd.gauge(
                    "work_queue.pending",
                    this.messages.length,
                    1,
                    [],
                    () => { /* intentionally empty */
                    });
                statsd.gauge(
                    "work_queue.events",
                    this.events.size,
                    1,
                    [],
                    () => { /* intentionally empty */
                    });
                statsd.gauge(
                    "work_queue.commands",
                    this.commands.size,
                    1,
                    [],
                    () => { /* intentionally empty */
                    });
            }
        }
    }
}

class Dispatched<T> {

    constructor(public result: Deferred<T>, public context: HandlerContext) {
    }
}

function hydrateContext(msg: WorkerMessage): HandlerContext {
    return {
        invocationId: msg.context.invocationId,
        correlationId: msg.context.correlationId,
        workspaceId: msg.context.workspaceId,
        context: msg.context,
    } as any as HandlerContext;
}
