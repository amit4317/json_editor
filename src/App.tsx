/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, memo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Position,
  Handle,
  Edge,
  Node,
  Panel,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  useViewport,
  getNodesBounds,
  getViewportForBounds,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  addEdge,
  Connection
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Editor from '@monaco-editor/react';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import { Check, X, Maximize, Minimize, Plus, Minus, Search, Menu, Focus, Sun, Moon, Download, Trash2, PlusSquare, Link2, MousePointer2, User, Mic, MicOff } from 'lucide-react';
import { soundService } from './services/soundService';
import { io, Socket } from 'socket.io-client';

const ThemeContext = createContext({ isDarkMode: true, toggleTheme: () => {} });
const CollaborationContext = createContext<{ socket: Socket | null, isRemoteUpdate: React.MutableRefObject<boolean>, canEdit: boolean }>({ socket: null, isRemoteUpdate: { current: false }, canEdit: false });
const WORKSPACE_PREFIX = '/workspace';
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]{6,64}$/;
const EDITOR_DEFAULT_WIDTH = 420;
const EDITOR_MIN_WIDTH = 260;
const GRAPH_MIN_WIDTH = 320;

const createWorkspaceId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
};

const getWorkspaceIdFromPath = (pathname: string): string | null => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== WORKSPACE_PREFIX.slice(1)) return null;
  const workspaceId = parts[1];
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) return null;
  return workspaceId;
};
const RTC_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

interface CursorProps {
  x: number;
  y: number;
  name: string;
  color: string;
  key?: string;
}

const Cursor = ({ x, y, name, color }: CursorProps) => (
  <div
    className="pointer-events-none absolute z-[1000] flex flex-col items-start transition-all duration-75 ease-out"
    style={{ left: x, top: y }}
  >
    <MousePointer2 size={20} fill={color} stroke="white" className="drop-shadow-md" />
    <div
      className="mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-white shadow-sm whitespace-nowrap"
      style={{ backgroundColor: color }}
    >
      {name}
    </div>
  </div>
);

const TooltipButton = ({ icon: Icon, tooltip, shortcut, onClick, disabled = false }: { icon: any, tooltip: string, shortcut?: string, onClick: () => void, disabled?: boolean }) => {
  const { isDarkMode } = useContext(ThemeContext);
  return (
    <div className="relative group flex items-center justify-center">
      <button disabled={disabled} onClick={onClick} className={`p-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isDarkMode ? 'text-[#a1a1aa] hover:text-white hover:bg-[#2a2a2a]' : 'text-[#6b7280] hover:text-[#111827] hover:bg-[#e5e7eb]'}`}>
        <Icon size={16} />
      </button>
      <div className={`absolute bottom-full mb-2 hidden group-hover:flex items-center whitespace-nowrap text-xs px-2 py-1.5 rounded shadow-lg pointer-events-none z-50 font-sans ${isDarkMode ? 'bg-[#f0f0f0] text-[#1e1e1e]' : 'bg-[#1e1e1e] text-[#f0f0f0]'}`}>
        {tooltip}
        {shortcut && <span className={`ml-2 ${isDarkMode ? 'text-[#888]' : 'text-[#a1a1aa]'}`}>{shortcut}</span>}
        <div className={`absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent ${isDarkMode ? 'border-t-[#f0f0f0]' : 'border-t-[#1e1e1e]'}`} />
      </div>
    </div>
  );
};

type RowData = {
  id: string;
  key: string;
  value: string;
  type: 'primitive' | 'object' | 'array';
  primitiveType?: 'string' | 'number' | 'boolean' | 'null';
  isColor?: boolean;
};

type NodeData = {
  rows: RowData[];
  isSyntheticRoot?: boolean;
  isPrimitiveArrayItemWrapper?: boolean;
};

type OnlineUser = {
  id: string;
  name: string;
  color: string;
  flowX?: number;
  flowY?: number;
};

type WorkspacePermissions = {
  ownerUserId: string | null;
  allowCollaboratorEdits: boolean;
  canEdit: boolean;
};

const JsonNode = memo(({ data, id }: { data: NodeData, id: string }) => {
  const { isDarkMode } = useContext(ThemeContext);
  const { socket, isRemoteUpdate, canEdit } = useContext(CollaborationContext);
  const { setNodes, getNodes } = useReactFlow();
  
  const bgClass = isDarkMode ? "bg-[#1e1e1e] border-[#333]" : "bg-white border-[#d1d5db]";
  const handleClass = isDarkMode ? "!bg-[#52525b]" : "!bg-[#d1d5db]";
  const rowBorderClass = isDarkMode ? "border-[#333] hover:bg-[#2a2a2a]" : "border-[#e5e7eb] hover:bg-[#f3f4f6]";
  const keyClass = isDarkMode ? "text-[#9cdcfe]" : "text-[#8b5cf6]";
  const stringClass = isDarkMode ? "text-[#ce9178]" : "text-[#e11d48]";
  const numberClass = isDarkMode ? "text-[#b5cea8]" : "text-[#e11d48]";
  const booleanClass = isDarkMode ? "text-[#569cd6]" : "text-[#3b82f6]";
  const objectClass = isDarkMode ? "text-[#a1a1aa]" : "text-[#6b7280]";

  const updateNodeData = (newRows: RowData[]) => {
    if (!canEdit) return;
    setNodes((nds) => {
      const nextNodes = nds.map((node) => {
        if (node.id === id) {
          return {
            ...node,
            data: { ...node.data, rows: newRows },
          };
        }
        return node;
      });
      
      if (!isRemoteUpdate.current) {
        socket?.emit('state-change', { nodes: nextNodes });
      }
      
      return nextNodes;
    });
  };

  const onKeyChange = (rowId: string, newKey: string) => {
    const newRows = data.rows.map((r) => (r.id === rowId ? { ...r, key: newKey } : r));
    updateNodeData(newRows);
  };

  const onValueChange = (rowId: string, newValue: string) => {
    const newRows = data.rows.map((r) => {
      if (r.id === rowId) {
        let primitiveType = r.primitiveType;
        if (!isNaN(Number(newValue)) && newValue.trim() !== '') primitiveType = 'number';
        else if (newValue === 'true' || newValue === 'false') primitiveType = 'boolean';
        else if (newValue === 'null') primitiveType = 'null';
        else primitiveType = 'string';

        return { ...r, value: newValue, primitiveType };
      }
      return r;
    });
    updateNodeData(newRows);
  };

  const onTypeChange = (rowId: string, newType: RowData['type']) => {
    const newRows = data.rows.map((r) => {
      if (r.id === rowId) {
        const displayValue = newType === 'array' ? '[ 0 items ]' : newType === 'object' ? '{ 0 keys }' : '';
        return { ...r, type: newType, value: displayValue };
      }
      return r;
    });
    updateNodeData(newRows);
  };

  const addRow = () => {
    if (!canEdit) return;
    soundService.playSuccess();
    const newRowId = `key-${Math.random().toString(36).substr(2, 5)}`;
    const newRows = [
      ...data.rows,
      { id: newRowId, key: 'newKey', value: 'newValue', type: 'primitive', primitiveType: 'string' } as RowData,
    ];
    updateNodeData(newRows);
  };

  const deleteRow = (rowId: string) => {
    if (!canEdit) return;
    soundService.playDelete();
    const newRows = data.rows.filter((r) => r.id !== rowId);
    updateNodeData(newRows);
  };

  const onDelete = () => {
    if (!canEdit) return;
    soundService.playDelete();
    setNodes((nds) => nds.filter((n) => n.id !== id));
  };

  return (
    <div className={`${bgClass} border rounded-md shadow-lg font-mono text-sm min-w-[250px] max-w-[450px] overflow-hidden group/node`}>
      <Handle type="target" position={Position.Left} className={`!w-2 !h-2 !border-none !-ml-1 ${handleClass}`} />
      <div className="flex items-center justify-between px-4 py-1 bg-black/10 border-b border-inherit">
        <span className="text-[10px] uppercase tracking-wider opacity-50 font-sans">Node: {id}</span>
        <div className="flex gap-1 opacity-0 group-hover/node:opacity-100 transition-opacity">
          <button onClick={addRow} disabled={!canEdit} className="p-1 hover:text-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" title="Add Row">
            <Plus size={12} />
          </button>
          <button onClick={onDelete} disabled={!canEdit} className="p-1 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed" title="Delete Node">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="flex flex-col">
        {data.rows.map((row) => (
          <div key={row.id} className={`relative flex items-center px-3 py-1.5 border-b last:border-b-0 ${rowBorderClass} group/row`}>
            <input
              value={row.key}
              onChange={(e) => onKeyChange(row.id, e.target.value)}
              readOnly={!canEdit}
              className={`${keyClass} bg-transparent outline-none w-20 shrink-0 border-b border-transparent focus:border-blue-500/30`}
            />
            <span className="mx-1 opacity-50">:</span>
            
            <div className="flex-1 flex items-center min-w-0">
              {row.type === 'primitive' ? (
                <input
                  value={row.value}
                  onChange={(e) => onValueChange(row.id, e.target.value)}
                  readOnly={!canEdit}
                  className={`flex-1 bg-transparent outline-none truncate border-b border-transparent focus:border-blue-500/30 ${
                    row.primitiveType === 'number' ? numberClass :
                    row.primitiveType === 'boolean' || row.primitiveType === 'null' ? booleanClass :
                    stringClass
                  }`}
                />
              ) : (
                <span className={`flex-1 truncate opacity-60 italic ${objectClass}`}>
                  {row.value}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1 ml-2 opacity-0 group-hover/row:opacity-100 transition-opacity">
              <select
                value={row.type}
                onChange={(e) => onTypeChange(row.id, e.target.value as any)}
                disabled={!canEdit}
                className="bg-transparent text-[10px] outline-none opacity-50 hover:opacity-100 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <option value="primitive">Val</option>
                <option value="object">Obj</option>
                <option value="array">Arr</option>
              </select>
              <button onClick={() => deleteRow(row.id)} disabled={!canEdit} className="text-red-500/50 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed">
                <X size={10} />
              </button>
            </div>

            <Handle
              type="source"
              position={Position.Right}
              id={row.id}
              className={`!w-2 !h-2 !border-none !-mr-1 ${handleClass}`}
              style={{ top: '50%', transform: 'translateY(-50%)' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
});

const CustomEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: any) => {
  const { isDarkMode } = useContext(ThemeContext);
  const { canEdit } = useContext(CollaborationContext);
  const { setEdges, setNodes, screenToFlowPosition } = useReactFlow();
  const [hoverPos, setHoverPos] = useState<{ x: number, y: number } | null>(null);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetPosition,
    targetX,
    targetY,
  });

  const onMouseEnter = (evt: React.MouseEvent) => {
    if (!canEdit) return;
    if (hoverPos) return; // Already showing
    const flowPos = screenToFlowPosition({ x: evt.clientX, y: evt.clientY });
    setHoverPos(flowPos);
  };

  const onMouseLeave = (evt: React.MouseEvent) => {
    // Check if we are moving into the label renderer
    const relatedTarget = evt.relatedTarget as HTMLElement;
    if (relatedTarget?.closest('.edge-actions')) return;
    setHoverPos(null);
  };

  const onEdgeClick = (evt: React.MouseEvent) => {
    if (!canEdit) return;
    evt.stopPropagation();
    soundService.playDelete();
    setEdges((eds) => eds.filter((e) => e.id !== id));
  };

  const onSplitEdge = (evt: React.MouseEvent) => {
    if (!canEdit) return;
    evt.stopPropagation();
    soundService.playSuccess();
    const newNodeId = `node-${Math.random().toString(36).substr(2, 9)}`;
    const position = hoverPos || { x: labelX, y: labelY };
    
    const newNode = {
      id: newNodeId,
      type: 'jsonNode',
      position,
      data: { rows: [{ id: 'new-key', key: 'newKey', value: 'newValue', type: 'primitive', primitiveType: 'string' }] },
    };

    setNodes((nds) => nds.concat(newNode));
    setEdges((eds) => {
      const currentEdge = eds.find((e) => e.id === id);
      if (!currentEdge) return eds;

      const newEdges = eds.filter((e) => e.id !== id).concat([
        {
          ...currentEdge,
          id: `e-${currentEdge.source}-${newNodeId}`,
          target: newNodeId,
        },
        {
          ...currentEdge,
          id: `e-${newNodeId}-${currentEdge.target}`,
          source: newNodeId,
          sourceHandle: 'new-key',
        }
      ]);
      return newEdges;
    });
  };

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={30}
        className="react-flow__edge-interaction"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        style={{ cursor: 'pointer' }}
      />
      <EdgeLabelRenderer>
        {hoverPos && (
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${hoverPos.x}px,${hoverPos.y}px)`,
              fontSize: 12,
              pointerEvents: 'all',
            }}
            className="nodrag nopan edge-actions"
            onMouseLeave={() => setHoverPos(null)}
          >
            <div className="flex gap-1 bg-white dark:bg-[#1e1e1e] border border-gray-200 dark:border-[#333] rounded-md p-1 shadow-lg">
              <button
                className="p-1 hover:bg-gray-100 dark:hover:bg-[#2a2a2a] rounded text-blue-500"
                onClick={onSplitEdge}
                title="Add table between"
              >
                <PlusSquare size={14} />
              </button>
              <button
                className="p-1 hover:bg-gray-100 dark:hover:bg-[#2a2a2a] rounded text-red-500"
                onClick={onEdgeClick}
                title="Delete connection"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
};

const nodeTypes = {
  jsonNode: JsonNode,
};

const edgeTypes = {
  default: CustomEdge,
};

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'LR') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  
  dagreGraph.setGraph({ rankdir: direction, ranksep: 300, nodesep: 100, edgesep: 50 });

  nodes.forEach((node) => {
    const width = node.measured?.width ?? 300;
    const height = node.measured?.height ?? 100;
    dagreGraph.setNode(node.id, { width, height });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - (node.measured?.width ?? 300) / 2,
        y: nodeWithPosition.y - (node.measured?.height ?? 100) / 2,
      },
      style: { opacity: 1 },
    };
  });

  return { nodes: newNodes, edges };
};

function generateGraph(json: any, isDarkMode: boolean) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  function processValue(
    value: any,
    nodeId: string,
    edgeSource: string | null,
    edgeSourceHandle: string | null,
    edgeLabel: string,
    isPrimitiveArrayItemWrapper: boolean = false
  ) {
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          const childNodeId = `${nodeId}-${index}`;
          const isPrimitiveItem = item === null || typeof item !== 'object';
          processValue(item, childNodeId, edgeSource, edgeSourceHandle, edgeLabel, isPrimitiveItem);
        });
      } else {
        const rows: RowData[] = [];
        const keys = Object.keys(value);
        
        keys.forEach((key) => {
          const val = value[key];
          const rowId = key;
          let type: 'primitive' | 'object' | 'array' = 'primitive';
          let primitiveType: RowData['primitiveType'] = 'string';
          let displayValue = '';
          let isColor = false;

          if (val === null) {
            primitiveType = 'null';
            displayValue = 'null';
          } else if (Array.isArray(val)) {
            type = 'array';
            displayValue = `[ ${val.length} items ]`;
          } else if (typeof val === 'object') {
            type = 'object';
            displayValue = `{ ${Object.keys(val).length} keys }`;
          } else {
            displayValue = String(val);
            if (typeof val === 'number') primitiveType = 'number';
            else if (typeof val === 'boolean') primitiveType = 'boolean';
            else if (typeof val === 'string') {
              primitiveType = 'string';
              if (/^#([0-9A-F]{3}){1,2}$/i.test(val)) {
                isColor = true;
              }
            }
          }

          rows.push({
            id: rowId,
            key,
            value: displayValue,
            type,
            primitiveType,
            isColor
          });
        });

        nodes.push({
          id: nodeId,
          type: 'jsonNode',
          data: {
            rows,
            isSyntheticRoot: nodeId === 'root' && hasSyntheticRoot,
            isPrimitiveArrayItemWrapper
          },
          position: { x: 0, y: 0 },
        });

        if (edgeSource && edgeSourceHandle) {
          edges.push({
            id: `e-${edgeSource}-${edgeSourceHandle}-${nodeId}`,
            source: edgeSource,
            sourceHandle: edgeSourceHandle,
            target: nodeId,
            label: edgeLabel,
            type: 'default',
            style: { stroke: isDarkMode ? '#52525b' : '#9ca3af', strokeWidth: 2 },
            labelStyle: { fill: isDarkMode ? '#a1a1aa' : '#4b5563', fontSize: 12, fontFamily: 'monospace' },
            labelBgStyle: { fill: isDarkMode ? '#18181b' : '#ffffff', fillOpacity: 0.8 },
            labelBgPadding: [8, 4],
            labelBgBorderRadius: 4,
          });
        }

        keys.forEach((key) => {
          const val = value[key];
          if (typeof val === 'object' && val !== null) {
            const childNodeId = `${nodeId}-${key}`;
            processValue(val, childNodeId, nodeId, key, key);
          }
        });
      }
    } else {
      let primitiveType: RowData['primitiveType'] = 'string';
      if (value === null) primitiveType = 'null';
      else if (typeof value === 'number') primitiveType = 'number';
      else if (typeof value === 'boolean') primitiveType = 'boolean';
      // Primitive root
      nodes.push({
        id: nodeId,
        type: 'jsonNode',
        data: {
          rows: [{ id: 'root', key: 'value', value: value === null ? 'null' : String(value), type: 'primitive', primitiveType }],
          isPrimitiveArrayItemWrapper
        },
        position: { x: 0, y: 0 },
      });
      if (edgeSource && edgeSourceHandle) {
        edges.push({
          id: `e-${edgeSource}-${edgeSourceHandle}-${nodeId}`,
          source: edgeSource,
          sourceHandle: edgeSourceHandle,
          target: nodeId,
          label: edgeLabel,
          type: 'default',
          style: { stroke: isDarkMode ? '#52525b' : '#9ca3af', strokeWidth: 2 },
        });
      }
    }
  }

  const hasSyntheticRoot = Array.isArray(json) || typeof json !== 'object' || json === null;
  let rootObj = json;
  if (hasSyntheticRoot) {
    rootObj = { root: json };
  }

  processValue(rootObj, 'root', null, null, '');

  return { nodes, edges };
}

const initialJson = {
  "fruits": [
    {
      "name": "Apple",
      "color": "#FF0000",
      "details": {
        "type": "Pome",
        "season": "Fall"
      },
      "nutrients": {
        "calories": 52,
        "fiber": "2.4g",
        "vitaminC": "4.6mg"
      }
    },
    {
      "name": "Banana",
      "color": "#FFFF00",
      "details": {
        "type": "Berry",
        "season": "Year-round"
      },
      "nutrients": {
        "calories": 89,
        "fiber": "2.6g",
        "potassium": "358mg"
      }
    },
    {
      "name": "Orange",
      "color": "#FFA500",
      "details": {
        "type": "Citrus",
        "season": "Winter"
      },
      "nutrients": {
        "calories": 47,
        "fiber": "2.4g",
        "vitaminC": "53.2mg"
      }
    }
  ]
};

function Flow({ jsonText, debouncedJsonText, setJsonText, isValid, setIsValid, isFullScreen, setIsFullScreen, editorWidth, onEditorWidthSync, onPermissionChange }: { jsonText: string, debouncedJsonText: string, setJsonText: (t: string) => void, isValid: boolean, setIsValid: (v: boolean) => void, isFullScreen: boolean, setIsFullScreen: (v: boolean) => void, editorWidth: number, onEditorWidthSync: (width: number) => void, onPermissionChange: (canEdit: boolean) => void }) {
  const { isDarkMode, toggleTheme } = useContext(ThemeContext);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView, getNodes, getEdges, zoomIn, zoomOut, setCenter, screenToFlowPosition } = useReactFlow();
  const workspaceId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return getWorkspaceIdFromPath(window.location.pathname);
  }, []);
  const viewport = useViewport();
  const nodesInitialized = useNodesInitialized();
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isConnectionMode, setIsConnectionMode] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const lastSyncedJsonRef = useRef<string>('');
  
  // Collaboration state
  const socketRef = useRef<Socket | null>(null);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, { flowX: number, flowY: number, name: string, color: string }>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, OnlineUser>>({});
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [followedUserId, setFollowedUserId] = useState<string | null>(null);
  const [workspaceOwnerUserId, setWorkspaceOwnerUserId] = useState<string | null>(null);
  const [allowCollaboratorEdits, setAllowCollaboratorEdits] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(false);
  const [voicePeerCount, setVoicePeerCount] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const isVoiceEnabledRef = useRef(false);
  const localAudioStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const remoteAudioElementsRef = useRef<Record<string, HTMLAudioElement>>({});
  const pendingIceCandidatesRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const pendingEditorWidthSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRemoteUpdateRef = useRef(false);
  const hasReceivedInitStateRef = useRef(false);
  const userColor = useMemo(() => {
    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
    return colors[Math.floor(Math.random() * colors.length)];
  }, []);
  const onlineUsersList = useMemo(() => {
    const users = Object.values(onlineUsers) as OnlineUser[];
    return users.sort((a, b) => {
      if (a.id === selfUserId) return -1;
      if (b.id === selfUserId) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [onlineUsers, selfUserId]);
  const isWorkspaceOwner = !!selfUserId && selfUserId === workspaceOwnerUserId;
  const applyWorkspacePermissions = useCallback((permissions?: Partial<WorkspacePermissions>) => {
    if (!permissions) return;

    const ownerUserId = permissions.ownerUserId ?? null;
    const sharedEdit = !!permissions.allowCollaboratorEdits;
    setWorkspaceOwnerUserId(ownerUserId);
    setAllowCollaboratorEdits(sharedEdit);

    const socketId = socketRef.current?.id ?? null;
    if (socketId) {
      setCanEdit(socketId === ownerUserId || sharedEdit);
      return;
    }

    if (typeof permissions.canEdit === 'boolean') {
      setCanEdit(permissions.canEdit);
    }
  }, []);

  const clearVoicePeers = useCallback(() => {
    Object.keys(peerConnectionsRef.current).forEach((remoteUserId) => {
      const pc = peerConnectionsRef.current[remoteUserId];
      if (!pc) return;
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch (_err) {
        // ignore cleanup errors
      }
      delete peerConnectionsRef.current[remoteUserId];
    });

    Object.keys(remoteAudioElementsRef.current).forEach((remoteUserId) => {
      const audioEl = remoteAudioElementsRef.current[remoteUserId];
      if (!audioEl) return;
      audioEl.pause();
      audioEl.srcObject = null;
      delete remoteAudioElementsRef.current[remoteUserId];
    });
    pendingIceCandidatesRef.current = {};
    setVoicePeerCount(0);
  }, []);

  const removeVoicePeer = useCallback((remoteUserId: string) => {
    const pc = peerConnectionsRef.current[remoteUserId];
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch (_err) {
        // ignore cleanup errors
      }
      delete peerConnectionsRef.current[remoteUserId];
    }

    const audioEl = remoteAudioElementsRef.current[remoteUserId];
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      delete remoteAudioElementsRef.current[remoteUserId];
    }

    delete pendingIceCandidatesRef.current[remoteUserId];
    setVoicePeerCount(Object.keys(peerConnectionsRef.current).length);
  }, []);

  const createVoicePeerConnection = useCallback((remoteUserId: string) => {
    const existing = peerConnectionsRef.current[remoteUserId];
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS });
    peerConnectionsRef.current[remoteUserId] = pc;

    const localStream = localAudioStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      socketRef.current?.emit('voice-ice-candidate', {
        targetUserId: remoteUserId,
        candidate: event.candidate.toJSON(),
      });
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;

      let audioEl = remoteAudioElementsRef.current[remoteUserId];
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        (audioEl as any).playsInline = true;
        remoteAudioElementsRef.current[remoteUserId] = audioEl;
      }
      audioEl.srcObject = stream;
      void audioEl.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        removeVoicePeer(remoteUserId);
      }
    };

    const pending = pendingIceCandidatesRef.current[remoteUserId];
    if (pending?.length) {
      pending.forEach((candidateInit) => {
        void pc.addIceCandidate(new RTCIceCandidate(candidateInit)).catch(() => {});
      });
      delete pendingIceCandidatesRef.current[remoteUserId];
    }

    setVoicePeerCount(Object.keys(peerConnectionsRef.current).length);
    return pc;
  }, [removeVoicePeer]);

  const createAndSendVoiceOffer = useCallback(async (remoteUserId: string) => {
    if (!isVoiceEnabledRef.current) return;
    try {
      const pc = createVoicePeerConnection(remoteUserId);
      if (pc.signalingState !== 'stable') return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('voice-offer', {
        targetUserId: remoteUserId,
        sdp: offer,
      });
    } catch (_err) {
      // ignore offer creation errors
    }
  }, [createVoicePeerConnection]);

  const stopVoiceChat = useCallback((notifyOthers: boolean = true) => {
    if (notifyOthers && isVoiceEnabledRef.current) {
      socketRef.current?.emit('voice-leave');
    }

    const localStream = localAudioStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localAudioStreamRef.current = null;
    }

    isVoiceEnabledRef.current = false;
    setIsVoiceEnabled(false);
    setVoiceError(null);
    clearVoicePeers();
  }, [clearVoicePeers]);

  const startVoiceChat = useCallback(async () => {
    if (isVoiceEnabledRef.current) return;
    setVoiceError(null);
    if (!socketRef.current) {
      setVoiceError('Socket is not connected yet.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError('Audio capture is not supported in this browser.');
      return;
    }
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localAudioStreamRef.current = localStream;
      isVoiceEnabledRef.current = true;
      setIsVoiceEnabled(true);
      socketRef.current?.emit('voice-join');
    } catch (_err) {
      setVoiceError('Microphone access is required for voice chat.');
    }
  }, []);

  const toggleVoiceChat = useCallback(() => {
    if (isVoiceEnabled) {
      stopVoiceChat();
    } else {
      void startVoiceChat();
    }
  }, [isVoiceEnabled, startVoiceChat, stopVoiceChat]);

  const toggleSharedEditAccess = useCallback(() => {
    if (!isWorkspaceOwner) return;
    const next = !allowCollaboratorEdits;
    setAllowCollaboratorEdits(next);
    setCanEdit(true);
    socketRef.current?.emit('set-edit-access', { allowCollaboratorEdits: next });
  }, [allowCollaboratorEdits, isWorkspaceOwner]);

  useEffect(() => {
    isVoiceEnabledRef.current = isVoiceEnabled;
  }, [isVoiceEnabled]);

  useEffect(() => {
    if (canEdit) return;
    setIsConnectionMode(false);
    setIsSelectionMode(false);
  }, [canEdit]);

  useEffect(() => {
    onPermissionChange(canEdit);
  }, [canEdit, onPermissionChange]);

  useEffect(() => {
    if (!selfUserId) return;
    setCanEdit(selfUserId === workspaceOwnerUserId || allowCollaboratorEdits);
  }, [allowCollaboratorEdits, selfUserId, workspaceOwnerUserId]);

  useEffect(() => {
    if (workspaceId) return;
    if (typeof window === 'undefined') return;
    const nextWorkspaceId = createWorkspaceId();
    window.location.replace(`${WORKSPACE_PREFIX}/${nextWorkspaceId}`);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    stopVoiceChat(false);
    setVoiceError(null);
    setOnlineUsers({});
    setRemoteCursors({});
    setFollowedUserId(null);
    setSelfUserId(null);
    setWorkspaceOwnerUserId(null);
    setAllowCollaboratorEdits(false);
    setCanEdit(false);
    hasReceivedInitStateRef.current = false;
    const socket = io({
      query: { workspaceId },
    });
    socketRef.current = socket;
    const toUserRecord = (users: OnlineUser[]) =>
      users.reduce<Record<string, OnlineUser>>((acc, user) => {
        if (!user?.id) return acc;
        acc[user.id] = user;
        return acc;
      }, {});

    socket.on('connect', () => {
      if (!socket.id) return;
      setSelfUserId(socket.id);
      socket.emit('set-user-meta', {
        name: `User ${socket.id.slice(0, 4)}`,
        color: userColor,
      });
      if (isVoiceEnabledRef.current) {
        clearVoicePeers();
        socket.emit('voice-join');
      }
    });

    socket.on('init-state', (state) => {
      if (state.workspaceId !== workspaceId) return;
      isRemoteUpdateRef.current = true;
      if (state.jsonText) setJsonText(state.jsonText);
      if (state.nodes) setNodes(state.nodes);
      if (state.edges) setEdges(state.edges);
      if (typeof state.isFullScreen === 'boolean') setIsFullScreen(state.isFullScreen);
      if (typeof state.editorWidth === 'number') onEditorWidthSync(state.editorWidth);
      if (Array.isArray(state.onlineUsers)) {
        setOnlineUsers(toUserRecord(state.onlineUsers));
      }
      applyWorkspacePermissions(state.permissions);
      hasReceivedInitStateRef.current = true;
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
    });

    socket.on('workspace-permissions', (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      applyWorkspacePermissions(payload);
    });

    socket.on('online-users', (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      if (!Array.isArray(payload.users)) return;
      setOnlineUsers(toUserRecord(payload.users));
    });

    socket.on('cursor-update', (data) => {
      if (!data || data.workspaceId !== workspaceId) return;
      setRemoteCursors(prev => ({
        ...prev,
        [data.userId]: { flowX: data.x, flowY: data.y, name: data.name, color: data.color }
      }));
      setOnlineUsers((prev) => {
        const existing = prev[data.userId];
        if (!existing && !data?.name && !data?.color) return prev;
        return {
          ...prev,
          [data.userId]: {
            id: data.userId,
            name: data?.name ?? existing?.name ?? `User ${String(data.userId).slice(0, 4)}`,
            color: data?.color ?? existing?.color ?? '#64748b',
            flowX: typeof data?.x === 'number' ? data.x : existing?.flowX,
            flowY: typeof data?.y === 'number' ? data.y : existing?.flowY,
          },
        };
      });
    });

    socket.on('state-update', (data) => {
      if (!data || data.workspaceId !== workspaceId) return;
      isRemoteUpdateRef.current = true;
      if (data.jsonText !== undefined) setJsonText(data.jsonText);
      if (data.nodes !== undefined) setNodes(data.nodes);
      if (data.edges !== undefined) setEdges(data.edges);
      if (typeof data.isFullScreen === 'boolean') setIsFullScreen(data.isFullScreen);
      if (typeof data.editorWidth === 'number') onEditorWidthSync(data.editorWidth);
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
    });

    socket.on('user-disconnected', (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      const userId = payload.userId;
      setRemoteCursors(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setOnlineUsers((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      removeVoicePeer(userId);
    });

    socket.on('voice-user-joined', (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      if (!isVoiceEnabledRef.current) return;
      const userId = payload.userId;
      if (!userId || userId === socket.id) return;
      void createAndSendVoiceOffer(userId);
    });

    socket.on('voice-user-left', (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      const userId = payload.userId;
      if (!userId) return;
      removeVoicePeer(userId);
    });

    socket.on('voice-offer', async (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      if (!isVoiceEnabledRef.current) return;

      const fromUserId = payload.fromUserId;
      const sdp = payload.sdp as RTCSessionDescriptionInit | undefined;
      if (!fromUserId || !sdp) return;

      try {
        const pc = createVoicePeerConnection(fromUserId);
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice-answer', {
          targetUserId: fromUserId,
          sdp: answer,
        });
      } catch (_err) {
        removeVoicePeer(fromUserId);
      }
    });

    socket.on('voice-answer', async (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      const fromUserId = payload.fromUserId;
      const sdp = payload.sdp as RTCSessionDescriptionInit | undefined;
      if (!fromUserId || !sdp) return;

      const pc = peerConnectionsRef.current[fromUserId];
      if (!pc) return;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (_err) {
        removeVoicePeer(fromUserId);
      }
    });

    socket.on('voice-ice-candidate', async (payload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      const fromUserId = payload.fromUserId;
      const candidate = payload.candidate as RTCIceCandidateInit | undefined;
      if (!fromUserId || !candidate) return;

      const pc = peerConnectionsRef.current[fromUserId];
      if (!pc) {
        pendingIceCandidatesRef.current[fromUserId] = pendingIceCandidatesRef.current[fromUserId] || [];
        pendingIceCandidatesRef.current[fromUserId].push(candidate);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (_err) {
        pendingIceCandidatesRef.current[fromUserId] = pendingIceCandidatesRef.current[fromUserId] || [];
        pendingIceCandidatesRef.current[fromUserId].push(candidate);
      }
    });

    return () => {
      stopVoiceChat(false);
      socket.disconnect();
      hasReceivedInitStateRef.current = false;
    };
  }, [applyWorkspacePermissions, clearVoicePeers, createAndSendVoiceOffer, createVoicePeerConnection, removeVoicePeer, setEdges, setJsonText, setNodes, stopVoiceChat, userColor, workspaceId]);

  useEffect(() => {
    if (!hasReceivedInitStateRef.current) return;
    if (isRemoteUpdateRef.current) return;
    socketRef.current?.emit('state-change', { isFullScreen });
  }, [isFullScreen]);

  useEffect(() => {
    if (!hasReceivedInitStateRef.current) return;
    if (isRemoteUpdateRef.current) return;
    if (pendingEditorWidthSyncRef.current) {
      clearTimeout(pendingEditorWidthSyncRef.current);
    }
    pendingEditorWidthSyncRef.current = setTimeout(() => {
      socketRef.current?.emit('state-change', { editorWidth });
      pendingEditorWidthSyncRef.current = null;
    }, 40);
    return () => {
      if (!pendingEditorWidthSyncRef.current) return;
      clearTimeout(pendingEditorWidthSyncRef.current);
      pendingEditorWidthSyncRef.current = null;
    };
  }, [editorWidth]);

  const onMouseMove = useCallback((evt: React.MouseEvent) => {
    if (!socketRef.current) return;
    const flowPos = screenToFlowPosition({ x: evt.clientX, y: evt.clientY });
    socketRef.current.emit('cursor-move', {
      x: flowPos.x,
      y: flowPos.y,
      name: `User ${socketRef.current.id?.slice(0, 4)}`,
      color: userColor
    });
  }, [screenToFlowPosition, userColor]);

  useEffect(() => {
    if (!followedUserId) return;
    if (!onlineUsers[followedUserId]) {
      setFollowedUserId(null);
    }
  }, [followedUserId, onlineUsers]);

  useEffect(() => {
    if (!followedUserId) return;
    const followedCursor = remoteCursors[followedUserId];
    const fallbackUser = onlineUsers[followedUserId];
    const flowX = followedCursor?.flowX ?? fallbackUser?.flowX;
    const flowY = followedCursor?.flowY ?? fallbackUser?.flowY;
    if (typeof flowX !== 'number' || typeof flowY !== 'number') return;
    setCenter(flowX, flowY, {
      zoom: viewport.zoom,
      duration: 120,
    });
  }, [followedUserId, onlineUsers, remoteCursors, setCenter, viewport.zoom]);

  const onConnect = useCallback((params: Connection) => {
    if (!canEdit) return;
    soundService.playConnect();
    setEdges((eds) => {
      const nextEdges = addEdge({ ...params, type: 'default' }, eds);
      if (!isRemoteUpdateRef.current) {
        socketRef.current?.emit('state-change', { edges: nextEdges });
      }
      return nextEdges;
    });
  }, [canEdit, setEdges]);

  const onAddTable = useCallback(() => {
    if (!canEdit) return;
    soundService.playSuccess();
    const id = `node-${Math.random().toString(36).substr(2, 9)}`;
    const newNode = {
      id,
      type: 'jsonNode',
      position: { x: Math.random() * 400, y: Math.random() * 400 },
      data: { rows: [{ id: 'key1', key: 'newKey', value: 'newValue', type: 'primitive', primitiveType: 'string' }] },
    };
    setNodes((nds) => {
      const nextNodes = nds.concat(newNode);
      if (!isRemoteUpdateRef.current) {
        socketRef.current?.emit('state-change', { nodes: nextNodes });
      }
      return nextNodes;
    });
  }, [canEdit, setNodes]);

  // Sync back to JSON when graph state changes.
  // Do not run this effect on raw editor keystrokes, otherwise in-progress typing can be overwritten.
  useEffect(() => {
    if (!canEdit || nodes.length === 0 || isRemoteUpdateRef.current) return;
    
    const buildJson = () => {
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      const edgeMap = new Map();
      edges.forEach(e => {
        if (!edgeMap.has(e.source)) edgeMap.set(e.source, []);
        edgeMap.get(e.source).push(e);
      });

      const visited = new Set();
      
      const processNode = (nodeId: string): any => {
        if (visited.has(nodeId)) return "[Circular]";
        visited.add(nodeId);
        
        const node = nodeMap.get(nodeId);
        if (!node) return null;

        const nodeEdges = edgeMap.get(nodeId) || [];
        const rows = (node.data as NodeData).rows;
        const nodeData = node.data as NodeData;

        // Unwrap synthetic wrapper nodes used internally for primitive array items.
        // This keeps arrays like ["a", "b"] from becoming [{ value: "a" }, { value: "b" }].
        if (nodeData.isPrimitiveArrayItemWrapper && rows.length > 0) {
          const row = rows[0];
          let val: any = row.value;
          if (row.primitiveType === 'number') val = Number(val);
          else if (row.primitiveType === 'boolean') val = val === 'true';
          else if (row.primitiveType === 'null') val = null;
          visited.delete(nodeId);
          return val;
        }
        
        // A node should serialize as an array only when its own row keys are numeric indexes.
        const isArray = rows.length > 0 && rows.every((r) => /^\d+$/.test(String(r.key).trim()));
        
        if (isArray) {
          const result: any[] = [];
          rows.forEach(row => {
            const rowEdges = nodeEdges.filter((e: any) => e.sourceHandle === row.id);
            if (rowEdges.length > 0) {
              rowEdges.forEach((edge: any) => {
                result.push(processNode(edge.target));
              });
            } else if (row.type === 'array') {
              result.push([]);
            } else if (row.type === 'object') {
              result.push({});
            } else {
              let val: any = row.value;
              if (row.primitiveType === 'number') val = Number(val);
              else if (row.primitiveType === 'boolean') val = val === 'true';
              else if (row.primitiveType === 'null') val = null;
              result.push(val);
            }
          });
          visited.delete(nodeId);
          return result;
        } else {
          const result: any = {};
          rows.forEach(row => {
            const rowEdges = nodeEdges.filter((e: any) => e.sourceHandle === row.id);

            if (row.type === 'array') {
              result[row.key] = rowEdges.length > 0
                ? rowEdges.map((edge: any) => processNode(edge.target))
                : [];
            } else if (row.type === 'object') {
              result[row.key] = rowEdges.length > 0
                ? processNode(rowEdges[0].target)
                : {};
            } else if (rowEdges.length > 0) {
              result[row.key] = processNode(rowEdges[0].target);
            } else {
              let val: any = row.value;
              if (row.primitiveType === 'number') val = Number(val);
              else if (row.primitiveType === 'boolean') val = val === 'true';
              else if (row.primitiveType === 'null') val = null;
              result[row.key] = val;
            }
          });
          visited.delete(nodeId);
          return result;
        }
      };

      // Find root nodes (nodes with no incoming edges)
      const targetNodes = new Set(edges.map(e => e.target));
      const rootNodes = nodes.filter(n => !targetNodes.has(n.id));
      
      if (rootNodes.length === 0 && nodes.length > 0) {
        return processNode(nodes[0].id);
      }

      if (rootNodes.length === 1) {
        const rootNode = rootNodes[0];
        const rootValue = processNode(rootNode.id);
        const rootData = rootNode.data as NodeData;

        if (
          rootData.isSyntheticRoot &&
          rootValue &&
          typeof rootValue === 'object' &&
          !Array.isArray(rootValue) &&
          Object.prototype.hasOwnProperty.call(rootValue, 'root')
        ) {
          return rootValue.root;
        }

        return rootValue;
      }

      const multiRoot: any = {};
      rootNodes.forEach(n => {
        multiRoot[n.id] = processNode(n.id);
      });
      return multiRoot;
    };

    const newJson = buildJson();
    const newText = JSON.stringify(newJson, null, 2);
    const isFormattingOnlyDifference = (() => {
      try {
        const parsedCurrent = JSON.parse(jsonText);
        return JSON.stringify(parsedCurrent) === JSON.stringify(newJson);
      } catch {
        return false;
      }
    })();
    if (isFormattingOnlyDifference) {
      return;
    }
    if (newText !== jsonText && newText !== lastSyncedJsonRef.current) {
      lastSyncedJsonRef.current = newText;
      setJsonText(newText);
      if (!isRemoteUpdateRef.current) {
        socketRef.current?.emit('state-change', { jsonText: newText });
      }
    }
  }, [canEdit, nodes, edges, setJsonText]);

  useEffect(() => {
    if (debouncedJsonText === lastSyncedJsonRef.current) return;
    
    try {
      const parsed = JSON.parse(debouncedJsonText);
      setIsValid(true);
      const { nodes: initialNodes, edges: initialEdges } = generateGraph(parsed, isDarkMode);
      setNodes(initialNodes.map(n => ({ ...n, style: { opacity: 0 } })));
      setEdges(initialEdges);
      lastSyncedJsonRef.current = debouncedJsonText;
      if (!isRemoteUpdateRef.current) {
        socketRef.current?.emit('state-change', { 
          jsonText: debouncedJsonText,
          nodes: initialNodes,
          edges: initialEdges
        });
      }
    } catch (e) {
      setIsValid(false);
    }
  }, [debouncedJsonText, setNodes, setEdges, setIsValid, isDarkMode]);

  const onExport = useCallback(() => {
    const nodes = getNodes();
    if (nodes.length === 0) return;

    const nodesBounds = getNodesBounds(nodes);
    const viewport = getViewportForBounds(nodesBounds, 1920, 1080, 0.5, 2, 0.1);

    const viewportElement = document.querySelector('.react-flow__viewport') as HTMLElement;
    if (!viewportElement) return;

    toPng(viewportElement, {
      backgroundColor: isDarkMode ? '#0d1117' : '#f8f9fa',
      width: 1920,
      height: 1080,
      style: {
        width: '1920px',
        height: '1080px',
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    }).then((dataUrl) => {
      soundService.playExport();
      const link = document.createElement('a');
      link.download = 'json-tree-export.png';
      link.href = dataUrl;
      link.click();
    });
  }, [getNodes, isDarkMode]);

  const deleteSelected = useCallback(() => {
    if (!canEdit) return;
    const selectedNodes = getNodes().filter(n => n.selected);
    const selectedEdges = getEdges().filter(e => e.selected);
    
    if (selectedNodes.length > 0 || selectedEdges.length > 0) {
      soundService.playDelete();
      const nextNodes = getNodes().filter(n => !n.selected);
      const nextEdges = getEdges().filter(e => !e.selected);
      setNodes(nextNodes);
      setEdges(nextEdges);
      if (!isRemoteUpdateRef.current) {
        socketRef.current?.emit('state-change', { nodes: nextNodes, edges: nextEdges });
      }
    }
  }, [canEdit, getNodes, getEdges, setNodes, setEdges]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isMonacoFocused = !!target.closest('.monaco-editor');

      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !isMonacoFocused) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only delete selected graph elements when focus is outside editable controls.
        const isEditableTarget =
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          isMonacoFocused;
        if (!isEditableTarget) {
          deleteSelected();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    
    if (!query) {
      setNodes(nds => nds.map(n => ({ ...n, style: { ...n.style, boxShadow: 'none' } })));
      return;
    }

    const currentNodes = getNodes();
    const match = currentNodes.find(n => {
      const data = n.data as NodeData;
      if (!data || !data.rows) return false;
      return data.rows.some(r => 
        r.key.toLowerCase().includes(query.toLowerCase()) || 
        String(r.value).toLowerCase().includes(query.toLowerCase())
      );
    });

    if (match) {
      const x = match.position.x + (match.measured?.width ?? 300) / 2;
      const y = match.position.y + (match.measured?.height ?? 100) / 2;
      setCenter(x, y, { zoom: 1.2, duration: 800 });
      
      setNodes(nds => nds.map(n => ({
        ...n,
        style: {
          ...n.style,
          boxShadow: n.id === match.id ? '0 0 0 2px #3b82f6, 0 4px 20px rgba(0,0,0,0.5)' : 'none'
        }
      })));
    } else {
      setNodes(nds => nds.map(n => ({ ...n, style: { ...n.style, boxShadow: 'none' } })));
    }
  };

  useEffect(() => {
    setEdges(eds => eds.map(e => ({
      ...e,
      style: { stroke: isDarkMode ? '#52525b' : '#9ca3af', strokeWidth: 2 },
      labelStyle: { fill: isDarkMode ? '#a1a1aa' : '#4b5563', fontSize: 12, fontFamily: 'monospace' },
      labelBgStyle: { fill: isDarkMode ? '#18181b' : '#ffffff', fillOpacity: 0.8 },
    })));
  }, [isDarkMode, setEdges]);

  useEffect(() => {
    if (nodesInitialized && nodes.length > 0 && nodes[0]?.style?.opacity === 0) {
      const currentNodes = getNodes();
      const currentEdges = getEdges();
      
      const allMeasured = currentNodes.every(n => n.measured?.width && n.measured?.height);
      if (!allMeasured) return;

      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(currentNodes, currentEdges);
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
      
      window.requestAnimationFrame(() => {
        fitView({ duration: 800, padding: 0.2 });
      });
    }
  }, [nodesInitialized, nodes, getNodes, getEdges, setNodes, setEdges, fitView]);

  return (
    <CollaborationContext.Provider value={{ socket: socketRef.current, isRemoteUpdate: isRemoteUpdateRef, canEdit }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
      onNodesChange={(changes) => {
        onNodesChange(changes);
        if (canEdit && !isRemoteUpdateRef.current) {
          socketRef.current?.emit('state-change', { nodes: getNodes() });
        }
      }}
      onEdgesChange={(changes) => {
        onEdgesChange(changes);
        if (canEdit && !isRemoteUpdateRef.current) {
          socketRef.current?.emit('state-change', { edges: getEdges() });
        }
      }}
      onConnect={onConnect}
      onMouseMove={onMouseMove}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      className={isDarkMode ? "bg-[#0d1117]" : "bg-[#f8f9fa]"}
      minZoom={0.05}
      maxZoom={2}
      nodesDraggable={canEdit}
      nodesConnectable={canEdit}
      elementsSelectable={true}
      panOnScroll={false}
      zoomOnScroll={true}
      selectionOnDrag={canEdit && isSelectionMode}
      panOnDrag={!isConnectionMode && !isSelectionMode}
      zoomOnDoubleClick={false}
      preventScrolling={true}
      onlyRenderVisibleElements={true}
      defaultEdgeOptions={{ type: 'default' }}
    >
      <Background color={isDarkMode ? "#30363d" : "#e5e7eb"} gap={20} size={1} />
      
      {/* Remote Cursors */}
      {Object.keys(remoteCursors).map((id) => {
        const cursor = remoteCursors[id];
        const x = cursor.flowX * viewport.zoom + viewport.x;
        const y = cursor.flowY * viewport.zoom + viewport.y;
        return <Cursor key={id} x={x} y={y} name={cursor.name} color={cursor.color} />;
      })}

      <Panel position="top-left" className="m-4 flex flex-col gap-2">
        <div className="flex gap-2">
          <button className={`p-2 border rounded-md transition-colors ${isDarkMode ? 'bg-[#1e1e1e] border-[#333] text-[#a1a1aa] hover:text-white hover:bg-[#2a2a2a]' : 'bg-white border-[#e5e7eb] text-[#6b7280] hover:text-[#111827] hover:bg-[#f3f4f6]'}`}>
            <Menu size={20} />
          </button>
          <button onClick={toggleTheme} className={`p-2 border rounded-md transition-colors ${isDarkMode ? 'bg-[#1e1e1e] border-[#333] text-[#a1a1aa] hover:text-white hover:bg-[#2a2a2a]' : 'bg-white border-[#e5e7eb] text-[#6b7280] hover:text-[#111827] hover:bg-[#f3f4f6]'}`}>
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
        <div className={`flex flex-col gap-2 p-1 border rounded-md ${isDarkMode ? 'bg-[#1e1e1e] border-[#333]' : 'bg-white border-[#e5e7eb]'}`}>
          <TooltipButton 
            icon={PlusSquare} 
            tooltip="Add Table" 
            onClick={onAddTable}
            disabled={!canEdit}
          />
          <TooltipButton 
            icon={Link2} 
            tooltip={isConnectionMode ? "Disable Connection Mode" : "Enable Connection Mode"} 
            onClick={() => {
              setIsConnectionMode(!isConnectionMode);
              if (!isConnectionMode) setIsSelectionMode(false);
            }}
            disabled={!canEdit}
          />
          <TooltipButton 
            icon={MousePointer2} 
            tooltip={isSelectionMode ? "Disable Selection Mode" : "Enable Selection Mode"} 
            onClick={() => {
              setIsSelectionMode(!isSelectionMode);
              if (!isSelectionMode) setIsConnectionMode(false);
            }}
            disabled={!canEdit}
          />
          <TooltipButton
            icon={isVoiceEnabled ? MicOff : Mic}
            tooltip={isVoiceEnabled ? "Disable Voice Chat" : "Enable Voice Chat"}
            onClick={toggleVoiceChat}
          />
          <TooltipButton 
            icon={Trash2} 
            tooltip="Delete Selected" 
            onClick={deleteSelected}
            disabled={!canEdit}
          />
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-medium transition-colors ${isDarkMode ? 'bg-[#1e1e1e] border-[#333] text-[#a1a1aa]' : 'bg-white border-[#e5e7eb] text-[#6b7280]'}`}>
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>{onlineUsersList.length} Online</span>
          </div>
          <button
            onClick={toggleVoiceChat}
            className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-medium transition-colors cursor-pointer ${
              isDarkMode
                ? 'bg-[#1e1e1e] border-[#333] text-[#a1a1aa] hover:bg-[#2a2a2a] hover:text-white'
                : 'bg-white border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827]'
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${isVoiceEnabled ? 'bg-blue-500 animate-pulse' : 'bg-gray-400'}`} />
            <span>{isVoiceEnabled ? `Voice On (${voicePeerCount + 1})` : 'Voice Off'}</span>
          </button>
          {voiceError && (
            <div className="px-2 py-1 text-[10px] rounded border border-rose-500/40 text-rose-400">
              {voiceError}
            </div>
          )}
        </div>
      </Panel>

      <Panel position="top-right" className="m-4">
        <div className={`min-w-[240px] max-w-[320px] border rounded-md p-2 shadow-xl transition-colors ${isDarkMode ? 'bg-[#1e1e1e] border-[#333]' : 'bg-white border-[#e5e7eb]'}`}>
          <div className="flex items-center justify-between mb-2">
            <div className={`flex items-center gap-1.5 text-xs font-semibold ${isDarkMode ? 'text-[#d4d4d4]' : 'text-[#374151]'}`}>
              <User size={12} />
              <span>Online Users</span>
            </div>
            {followedUserId && (
              <button
                onClick={() => setFollowedUserId(null)}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${isDarkMode ? 'text-[#a1a1aa] hover:text-white hover:bg-[#2a2a2a]' : 'text-[#6b7280] hover:text-[#111827] hover:bg-[#f3f4f6]'}`}
              >
                Stop Follow
              </button>
            )}
          </div>

          <div className={`mb-2 px-2 py-1.5 rounded border text-[10px] ${isDarkMode ? 'border-[#333] bg-[#161b22] text-[#a1a1aa]' : 'border-[#e5e7eb] bg-[#f9fafb] text-[#6b7280]'}`}>
            {isWorkspaceOwner ? (
              <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
                <span>Shared Edit Access</span>
                <input
                  type="checkbox"
                  checked={allowCollaboratorEdits}
                  onChange={toggleSharedEditAccess}
                  className="accent-blue-500"
                />
              </label>
            ) : (
              <span>{canEdit ? 'Edit access enabled by owner' : 'Read-only access'}</span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {onlineUsersList.map((user) => {
              const isSelf = user.id === selfUserId;
              const isFollowing = followedUserId === user.id;
              const displayName = isSelf ? 'You' : user.name;
              const initial = displayName.charAt(0).toUpperCase() || 'U';

              return (
                <button
                  key={user.id}
                  onClick={() => {
                    if (isSelf) {
                      setFollowedUserId(null);
                      return;
                    }
                    setFollowedUserId((prev) => (prev === user.id ? null : user.id));
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded border transition-colors text-left ${
                    isFollowing
                      ? isDarkMode
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-blue-400 bg-blue-50'
                      : isDarkMode
                        ? 'border-[#333] hover:bg-[#2a2a2a]'
                        : 'border-[#e5e7eb] hover:bg-[#f9fafb]'
                  }`}
                >
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white shrink-0"
                    style={{ backgroundColor: user.color }}
                  >
                    {initial}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`text-xs truncate ${isDarkMode ? 'text-[#d4d4d4]' : 'text-[#374151]'}`}>{displayName}</div>
                    <div className={`text-[10px] truncate ${isDarkMode ? 'text-[#8b949e]' : 'text-[#6b7280]'}`}>
                      {isSelf ? 'Your session' : isFollowing ? 'Following cursor' : 'Click to follow'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </Panel>
      <Panel position="bottom-center" className="mb-4">
        <div className={`flex items-center gap-1 border rounded-md p-1 shadow-xl transition-colors ${isDarkMode ? 'bg-[#1e1e1e] border-[#333]' : 'bg-white border-[#e5e7eb]'}`}>
          <TooltipButton icon={Focus} tooltip="Fit to center" shortcut="⇧2" onClick={() => fitView({ duration: 800 })} />
          <TooltipButton icon={isFullScreen ? Minimize : Maximize} tooltip={isFullScreen ? "Exit full screen" : "Full screen"} onClick={() => setIsFullScreen(!isFullScreen)} />
          <TooltipButton icon={Download} tooltip="Export PNG" onClick={onExport} />
          <div className={`w-px h-4 mx-1 ${isDarkMode ? 'bg-[#333]' : 'bg-[#e5e7eb]'}`} />
          <TooltipButton icon={Minus} tooltip="Zoom out" onClick={() => zoomOut({ duration: 300 })} />
          <TooltipButton icon={Plus} tooltip="Zoom in" onClick={() => zoomIn({ duration: 300 })} />
          <div className={`w-px h-4 mx-1 ${isDarkMode ? 'bg-[#333]' : 'bg-[#e5e7eb]'}`} />
          <div className={`flex items-center px-2 text-sm ${isDarkMode ? 'text-[#a1a1aa]' : 'text-[#6b7280]'}`}>
            <Search size={14} className="mr-2" />
            <input 
              ref={searchInputRef}
              type="text" 
              placeholder="Search Node (Ctrl + F)" 
              className={`bg-transparent outline-none w-40 ${isDarkMode ? 'placeholder-[#666] text-white' : 'placeholder-[#9ca3af] text-[#111827]'}`}
              value={searchQuery}
              onChange={handleSearch}
            />
          </div>
        </div>
      </Panel>
    </ReactFlow>
    </CollaborationContext.Provider>
  );
}

export default function App() {
  const [jsonText, setJsonText] = useState(JSON.stringify(initialJson, null, 2));
  const [debouncedJsonText, setDebouncedJsonText] = useState(jsonText);
  const [isValid, setIsValid] = useState(true);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [hasEditAccess, setHasEditAccess] = useState(false);
  const [editorWidth, setEditorWidth] = useState(EDITOR_DEFAULT_WIDTH);
  const editorResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const editorWidthBeforeFullscreenRef = useRef(EDITOR_DEFAULT_WIDTH);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedJsonText(jsonText), 500);
    return () => clearTimeout(timer);
  }, [jsonText]);

  const toggleTheme = useCallback(() => {
    soundService.playToggle();
    setIsDarkMode(prev => !prev);
  }, []);

  const clampEditorWidth = useCallback((width: number) => {
    if (typeof window === 'undefined') {
      return Math.max(EDITOR_MIN_WIDTH, width);
    }
    const maxWidth = Math.max(EDITOR_MIN_WIDTH, window.innerWidth - GRAPH_MIN_WIDTH);
    return Math.min(Math.max(width, EDITOR_MIN_WIDTH), maxWidth);
  }, []);

  const applySyncedEditorWidth = useCallback((width: number) => {
    const clampedWidth = clampEditorWidth(width);
    editorWidthBeforeFullscreenRef.current = clampedWidth;
    setEditorWidth(clampedWidth);
  }, [clampEditorWidth]);

  const handleResizeMove = useCallback((event: MouseEvent) => {
    const resizeState = editorResizeRef.current;
    if (!resizeState) return;
    const nextWidth = resizeState.startWidth + (event.clientX - resizeState.startX);
    setEditorWidth(clampEditorWidth(nextWidth));
  }, [clampEditorWidth]);

  const stopEditorResize = useCallback(() => {
    if (!editorResizeRef.current) return;
    editorResizeRef.current = null;
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup', stopEditorResize);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [handleResizeMove]);

  const startEditorResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    editorResizeRef.current = { startX: event.clientX, startWidth: editorWidth };
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', stopEditorResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [editorWidth, handleResizeMove, stopEditorResize]);

  useEffect(() => {
    const handleWindowResize = () => {
      if (isFullScreen) return;
      setEditorWidth((currentWidth) => clampEditorWidth(currentWidth));
    };

    handleWindowResize();
    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      stopEditorResize();
    };
  }, [clampEditorWidth, isFullScreen, stopEditorResize]);

  useEffect(() => {
    if (isFullScreen) {
      stopEditorResize();
      return;
    }

    setEditorWidth(clampEditorWidth(editorWidthBeforeFullscreenRef.current));
  }, [clampEditorWidth, isFullScreen, stopEditorResize]);

  useEffect(() => {
    if (isFullScreen) return;
    editorWidthBeforeFullscreenRef.current = editorWidth;
  }, [editorWidth, isFullScreen]);

  return (
    <ThemeContext.Provider value={{ isDarkMode, toggleTheme }}>
      <div className={`flex h-screen w-full overflow-hidden transition-colors duration-200 ${isDarkMode ? 'bg-[#0d1117] text-white' : 'bg-[#f8f9fa] text-[#111827]'}`}>
        {/* Left Panel - Editor */}
        {!isFullScreen && (
          <div
            className={`relative shrink-0 flex flex-col border-r transition-colors duration-200 ${isDarkMode ? 'border-[#30363d] bg-[#1e1e1e]' : 'border-[#e5e7eb] bg-white'}`}
            style={{ width: `${editorWidth}px` }}
          >
            <div className="flex-1 overflow-hidden">
              <Editor
                height="100%"
                language="json"
                value={jsonText}
                onChange={(value) => {
                  if (!hasEditAccess) return;
                  setJsonText(value ?? '');
                }}
                theme={isDarkMode ? 'vs-dark' : 'light'}
                options={{
                  readOnly: !hasEditAccess,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  fontSize: 13,
                  tabSize: 2,
                  formatOnPaste: false,
                  formatOnType: false,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  autoIndent: 'none',
                  autoClosingBrackets: 'never',
                  autoClosingQuotes: 'never',
                  autoClosingDelete: 'never',
                  autoClosingOvertype: 'never',
                  autoSurround: 'never',
                  quickSuggestions: false,
                  suggestOnTriggerCharacters: false,
                  acceptSuggestionOnEnter: 'off',
                  tabCompletion: 'off',
                  snippetSuggestions: 'none',
                  wordBasedSuggestions: 'off',
                  parameterHints: { enabled: false },
                  inlineSuggest: { enabled: false },
                }}
              />
            </div>
            
            {/* Status Bar */}
            <div className={`h-8 border-t flex items-center px-4 text-xs font-mono shrink-0 transition-colors duration-200 ${isDarkMode ? 'border-[#333] bg-[#1e1e1e]' : 'border-[#e5e7eb] bg-[#f9fafb]'}`}>
              {isValid ? (
                <div className="flex items-center text-emerald-500">
                  <Check size={14} className="mr-1" /> Valid
                </div>
              ) : (
                <div className="flex items-center text-rose-500">
                  <X size={14} className="mr-1" /> Invalid JSON
                </div>
              )}
              <div className={`ml-4 flex items-center ${isDarkMode ? 'text-[#8b949e]' : 'text-[#6b7280]'}`}>
                <div className="w-2 h-2 rounded-full bg-emerald-500 mr-2 animate-pulse" />
                Live Transform
              </div>
              <div className={`ml-auto ${isDarkMode ? 'text-[#8b949e]' : 'text-[#6b7280]'}`}>JSON</div>
              {!hasEditAccess && (
                <div className="ml-3 text-amber-500">Read Only</div>
              )}
            </div>
            <div
              role="separator"
              aria-label="Resize JSON editor panel"
              aria-orientation="vertical"
              className={`absolute right-0 top-0 h-full w-1.5 translate-x-1/2 cursor-col-resize ${isDarkMode ? 'hover:bg-blue-500/40 active:bg-blue-500/60' : 'hover:bg-blue-400/40 active:bg-blue-400/60'}`}
              onMouseDown={startEditorResize}
            />
          </div>
        )}

        {/* Right Panel - Graph */}
        <div className={`flex-1 relative transition-colors duration-200 ${isDarkMode ? 'bg-[#0d1117]' : 'bg-[#f8f9fa]'}`}>
          <ReactFlowProvider>
            <Flow jsonText={jsonText} debouncedJsonText={debouncedJsonText} setJsonText={setJsonText} isValid={isValid} setIsValid={setIsValid} isFullScreen={isFullScreen} setIsFullScreen={setIsFullScreen} editorWidth={editorWidth} onEditorWidthSync={applySyncedEditorWidth} onPermissionChange={setHasEditAccess} />
          </ReactFlowProvider>
        </div>
      </div>
    </ThemeContext.Provider>
  );
}
