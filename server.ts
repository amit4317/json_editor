import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PREFIX = "/workspace";
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]{6,64}$/;

const createWorkspaceId = () => randomUUID().replace(/-/g, "").slice(0, 12);
const getWorkspaceQueryId = (queryValue: unknown): string | undefined => {
  if (Array.isArray(queryValue)) {
    return typeof queryValue[0] === "string" ? queryValue[0] : undefined;
  }
  return typeof queryValue === "string" ? queryValue : undefined;
};
const sanitizeWorkspaceId = (candidate: string | undefined): string => {
  if (!candidate) return createWorkspaceId();
  const trimmed = candidate.trim();
  if (!WORKSPACE_ID_PATTERN.test(trimmed)) return createWorkspaceId();
  return trimmed;
};

type WorkspaceUser = {
  id: string;
  name: string;
  color: string;
  flowX?: number;
  flowY?: number;
};

type WorkspaceState = {
  jsonText: string;
  nodes: any[];
  edges: any[];
  connectedUsers: Map<string, WorkspaceUser>;
  ownerSocketId: string | null;
  allowCollaboratorEdits: boolean;
};

const createWorkspaceState = (): WorkspaceState => ({
  jsonText: "",
  nodes: [],
  edges: [],
  connectedUsers: new Map(),
  ownerSocketId: null,
  allowCollaboratorEdits: false,
});

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const PORT = 3000;
  const workspaces = new Map<string, WorkspaceState>();
  const getWorkspaceState = (workspaceId: string): WorkspaceState => {
    let workspace = workspaces.get(workspaceId);
    if (!workspace) {
      workspace = createWorkspaceState();
      workspaces.set(workspaceId, workspace);
    }
    return workspace;
  };
  const getOnlineUsers = (workspace: WorkspaceState) =>
    Array.from(workspace.connectedUsers.values());
  const getPermissionsPayload = (workspace: WorkspaceState, socketId: string) => ({
    ownerUserId: workspace.ownerSocketId,
    allowCollaboratorEdits: workspace.allowCollaboratorEdits,
    canEdit:
      socketId === workspace.ownerSocketId || workspace.allowCollaboratorEdits,
  });

  app.get(["/", WORKSPACE_PREFIX, `${WORKSPACE_PREFIX}/`], (_req, res) => {
    res.redirect(`${WORKSPACE_PREFIX}/${createWorkspaceId()}`);
  });

  io.on("connection", (socket) => {
    const queryWorkspaceId = getWorkspaceQueryId(socket.handshake.query.workspaceId);
    const workspaceId = sanitizeWorkspaceId(queryWorkspaceId);
    const workspace = getWorkspaceState(workspaceId);
    socket.join(workspaceId);
    if (!workspace.ownerSocketId) {
      workspace.ownerSocketId = socket.id;
    }

    console.log(`User connected: ${socket.id} -> ${workspaceId}`);
    workspace.connectedUsers.set(socket.id, {
      id: socket.id,
      name: `User ${socket.id.slice(0, 4)}`,
      color: "#64748b",
    });
    io.to(workspaceId).emit("online-users", {
      workspaceId,
      users: getOnlineUsers(workspace),
    });

    // Send initial state to new user
    socket.emit("init-state", {
      workspaceId,
      jsonText: workspace.jsonText,
      nodes: workspace.nodes,
      edges: workspace.edges,
      onlineUsers: getOnlineUsers(workspace),
      permissions: getPermissionsPayload(workspace, socket.id),
    });

    socket.on("set-user-meta", (data) => {
      const existing = workspace.connectedUsers.get(socket.id);
      if (!existing) return;

      const nextUser = { ...existing };
      if (typeof data?.name === "string" && data.name.trim().length > 0) {
        nextUser.name = data.name.trim();
      }
      if (typeof data?.color === "string" && data.color.trim().length > 0) {
        nextUser.color = data.color.trim();
      }

      workspace.connectedUsers.set(socket.id, nextUser);
      io.to(workspaceId).emit("online-users", {
        workspaceId,
        users: getOnlineUsers(workspace),
      });
    });

    socket.on("set-edit-access", (data) => {
      if (socket.id !== workspace.ownerSocketId) return;
      if (typeof data?.allowCollaboratorEdits !== "boolean") return;

      workspace.allowCollaboratorEdits = data.allowCollaboratorEdits;
      io.to(workspaceId).emit("workspace-permissions", {
        workspaceId,
        ownerUserId: workspace.ownerSocketId,
        allowCollaboratorEdits: workspace.allowCollaboratorEdits,
      });
    });

    socket.on("cursor-move", (data) => {
      const existing = workspace.connectedUsers.get(socket.id);
      let shouldBroadcastUsers = false;
      if (existing) {
        const nextUser = { ...existing };
        if (typeof data?.x === "number") nextUser.flowX = data.x;
        if (typeof data?.y === "number") nextUser.flowY = data.y;
        if (
          typeof data?.name === "string" &&
          data.name.trim().length > 0 &&
          data.name.trim() !== existing.name
        ) {
          nextUser.name = data.name.trim();
          shouldBroadcastUsers = true;
        }
        if (
          typeof data?.color === "string" &&
          data.color.trim().length > 0 &&
          data.color.trim() !== existing.color
        ) {
          nextUser.color = data.color.trim();
          shouldBroadcastUsers = true;
        }
        workspace.connectedUsers.set(socket.id, nextUser);
      }

      socket.to(workspaceId).emit("cursor-update", {
        workspaceId,
        userId: socket.id,
        ...data,
      });

      if (shouldBroadcastUsers) {
        io.to(workspaceId).emit("online-users", {
          workspaceId,
          users: getOnlineUsers(workspace),
        });
      }
    });

    socket.on("voice-join", () => {
      socket.to(workspaceId).emit("voice-user-joined", {
        workspaceId,
        userId: socket.id,
      });
    });

    socket.on("voice-leave", () => {
      socket.to(workspaceId).emit("voice-user-left", {
        workspaceId,
        userId: socket.id,
      });
    });

    socket.on("voice-offer", (data) => {
      const targetUserId =
        typeof data?.targetUserId === "string" ? data.targetUserId : null;
      if (!targetUserId || !workspace.connectedUsers.has(targetUserId)) return;

      io.to(targetUserId).emit("voice-offer", {
        workspaceId,
        fromUserId: socket.id,
        sdp: data?.sdp,
      });
    });

    socket.on("voice-answer", (data) => {
      const targetUserId =
        typeof data?.targetUserId === "string" ? data.targetUserId : null;
      if (!targetUserId || !workspace.connectedUsers.has(targetUserId)) return;

      io.to(targetUserId).emit("voice-answer", {
        workspaceId,
        fromUserId: socket.id,
        sdp: data?.sdp,
      });
    });

    socket.on("voice-ice-candidate", (data) => {
      const targetUserId =
        typeof data?.targetUserId === "string" ? data.targetUserId : null;
      if (!targetUserId || !workspace.connectedUsers.has(targetUserId)) return;

      io.to(targetUserId).emit("voice-ice-candidate", {
        workspaceId,
        fromUserId: socket.id,
        candidate: data?.candidate,
      });
    });

    socket.on("state-change", (data) => {
      const canEdit =
        socket.id === workspace.ownerSocketId || workspace.allowCollaboratorEdits;
      if (!canEdit) return;

      workspace.jsonText = data.jsonText ?? workspace.jsonText;
      workspace.nodes = data.nodes ?? workspace.nodes;
      workspace.edges = data.edges ?? workspace.edges;
      
      socket.to(workspaceId).emit("state-update", {
        workspaceId,
        ...data,
      });
    });

    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id} -> ${workspaceId}`);
      workspace.connectedUsers.delete(socket.id);
      let ownerChanged = false;
      if (workspace.ownerSocketId === socket.id) {
        const nextOwnerId = workspace.connectedUsers.keys().next().value ?? null;
        workspace.ownerSocketId = nextOwnerId;
        ownerChanged = true;
      }
      io.to(workspaceId).emit("online-users", {
        workspaceId,
        users: getOnlineUsers(workspace),
      });
      io.to(workspaceId).emit("user-disconnected", { workspaceId, userId: socket.id });
      io.to(workspaceId).emit("voice-user-left", { workspaceId, userId: socket.id });
      if (ownerChanged) {
        io.to(workspaceId).emit("workspace-permissions", {
          workspaceId,
          ownerUserId: workspace.ownerSocketId,
          allowCollaboratorEdits: workspace.allowCollaboratorEdits,
        });
      }
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
  });
}

startServer();
