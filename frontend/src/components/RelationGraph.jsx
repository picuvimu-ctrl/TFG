import React, { useState, useEffect } from 'react';
import SearchableSelect from './common/SearchableSelect';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
  getNodesBounds,
} from 'reactflow';
import { toPng } from 'html-to-image';
import download from 'downloadjs';
import 'reactflow/dist/style.css';
import api from '../api';
import {
  createEdgeStyle,
  getLayoutedElements,
  getHierarchicalLayoutedElements,
  buildTreeEdgesFromRelations,
  buildGenerationalLevels,
} from './relationGraphUtils';
import { KINSHIP_COLORS, KINSHIP_MAPPING, getEdgeStyle } from '../data/kinship_styles';
import { ChevronDown, Filter, X } from 'lucide-react';const PersonaNode = ({ data, selected }) => {
  // Función para formatear fechas de forma legible (DD-MM-YYYY)
  const formatPartialDate = (dateStr) => {
    if (!dateStr) return '-';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    
    const [day, month, year] = parts;
    const isDayUnknown = day === '00';
    const isMonthUnknown = month === '00';

    if (isMonthUnknown) return year;
    if (isDayUnknown) return `${month}-${year}`;
    return `${day}-${month}-${year}`;
  };

  return (
    <div 
      className={`relative px-4 py-4 rounded-xl border-2 transition-all duration-200 min-w-[200px] min-h-[100px] flex flex-col justify-center ${
        selected 
          ? 'bg-blue-900/90 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.5)]' 
          : 'bg-slate-800 border-slate-700 hover:border-slate-500'
      }`}
    >
      {/* Handles Generacionales (Arriba/Abajo) */}
      <Handle type="target" position={Position.Top} className="w-3 h-3 !bg-blue-500 border-2 border-slate-900" id="top" />
      <Handle type="source" position={Position.Bottom} className="w-3 h-3 !bg-emerald-500 border-2 border-slate-900" id="bottom" />
      
      {/* Handles Laterales (Izquierda/Derecha) */}
      <Handle type="source" position={Position.Left} className="!opacity-0" id="left-source" />
      <Handle type="target" position={Position.Left} className="!opacity-0" id="left-target" />
      <Handle type="source" position={Position.Right} className="!opacity-0" id="right-source" />
      <Handle type="target" position={Position.Right} className="!opacity-0" id="right-target" />

      <div className="flex flex-col items-center gap-2 text-white">
        <div className="font-bold text-center leading-tight text-lg border-b border-slate-600 pb-1 w-full">
          {data.nombre}
        </div>
        
        <div className="flex flex-col items-center text-xs space-y-1 w-full">
          <div className="flex justify-between w-full px-2">
            <span className="text-blue-400 font-semibold">Nac:</span>
            <span className="font-mono">{formatPartialDate(data.birth)}</span>
          </div>
          <div className="flex justify-between w-full px-2">
            <span className="text-red-400 font-semibold">Def:</span>
            <span className="font-mono">{formatPartialDate(data.death)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

const UnionNode = () => (
  <div className="w-1 h-1 bg-transparent border-none">
    <Handle type="target" position={Position.Left} id="left" style={{ opacity: 0, pointerEvents: 'none' }} />
    <Handle type="target" position={Position.Right} id="right" style={{ opacity: 0, pointerEvents: 'none' }} />
    <Handle type="source" position={Position.Bottom} id="bottom" style={{ opacity: 0, pointerEvents: 'none' }} />
    <Handle type="target" position={Position.Top} id="top" style={{ opacity: 0, pointerEvents: 'none' }} />
  </div>
);

const nodeTypes = {
  persona: PersonaNode,
  union: UnionNode,
};

const RelationGraphInner = ({ initialPersonaId, onViewPersona }) => {
  const { getNodes } = useReactFlow();
  const graphWrapperRef = React.useRef(null);
  const [personas, setPersonas] = useState([]);
  const [selectedPersona, setSelectedPersona] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [loading, setLoading] = useState(false);
  const [showAllRelations, setShowAllRelations] = useState(false);
  const [relationFilter, setRelationFilter] = useState('all'); // 'all', 'familiar', 'other'
  const [showExtendedNetwork, setShowExtendedNetwork] = useState(false); // mostrar red completa o solo adyacentes
  const [isExpanded, setIsExpanded] = useState(false); // controlar el tamaño del grafo
  const [showPathFinder, setShowPathFinder] = useState(false); // mostrar buscador de caminos
  const [pathStart, setPathStart] = useState(null); // persona inicio del camino
  const [pathEnd, setPathEnd] = useState(null); // persona fin del camino
  const [foundPath, setFoundPath] = useState(null); // camino encontrado
  const [pathError, setPathError] = useState(null); // error en la búsqueda de camino
  const [graphMode, setGraphMode] = useState('network'); // 'network' | 'tree'
  const [selectedDegrees, setSelectedDegrees] = useState(
    Array.from(new Set(Object.values(KINSHIP_MAPPING).map(m => m.filterKey)))
  ); // Filtro por grado de parentesco inicializado con todo
  const [showDegreeFilter, setShowDegreeFilter] = useState(false);
  const [degreeSearchTerm, setDegreeSearchTerm] = useState(''); // Buscador interno de grados
  const [visibleDegrees, setVisibleDegrees] = useState(
    Object.keys(KINSHIP_COLORS)
  ); // Control visual de qué flechas se muestran en el canvas
  const [showEdgeLabels, setShowEdgeLabels] = useState(true); // Control visual de si se muestran los nombres en las flechas
  const [isDownloading, setIsDownloading] = useState(false); // Estado específico para la captura de imagen

  // Cargar todas las personas
  useEffect(() => {
    const fetchPersonas = async () => {
      try {
        const res = await api.get('/personas/');
        setPersonas(res.data);
      } catch (error) {
        console.error('Error cargando personas:', error);
      }
    };
    fetchPersonas();
  }, []);

  const fetchGraphData = async () => {
    const [allPersonasRes, allRelacionesRes] = await Promise.all([
      api.get('/personas/'),
      api.get('/relaciones/todas/'),
    ]);

    const allPersonas = allPersonasRes.data;
    const allRelaciones = allRelacionesRes.data;
    const personaMap = new Map();
    allPersonas.forEach((p) => personaMap.set(p.id, p));

    return { allPersonas, allRelaciones, personaMap };
  };

  // Encontrar camino entre dos personas usando BFS
  const findPath = async (startId, endId) => {
    if (!startId || !endId || startId === endId) {
      return null;
    }

    setLoading(true);
    setPathError(null);
    setFoundPath(null);
    try {
      const { allPersonas, allRelaciones } = await fetchGraphData();
      
      const adjacencyMap = new Map();
      const personaDetails = new Map();
      
      allPersonas.forEach(p => {
        personaDetails.set(p.id, p);
        adjacencyMap.set(p.id, []);
      });

      allRelaciones.forEach(rel => {
        if (adjacencyMap.has(rel.persona_id)) {
          adjacencyMap.get(rel.persona_id).push({
            id: rel.persona_relacionada_id,
            tipo: rel.tipo_relacion,
            categoria: rel.categoria
          });
        }
        // También dirección inversa
        if (adjacencyMap.has(rel.persona_relacionada_id)) {
          adjacencyMap.get(rel.persona_relacionada_id).push({
            id: rel.persona_id,
            tipo: rel.tipo_relacion,
            categoria: rel.categoria
          });
        }
      });

      // BFS para encontrar el camino más corto
      const queue = [[startId]];
      const visited = new Set([startId]);

      while (queue.length > 0) {
        const path = queue.shift();
        const current = path[path.length - 1];

        if (current === endId) {
          // Camino encontrado, construir el grafo visual
          const pathNodes = [];
          const pathEdges = [];

          path.forEach((personaId, index) => {
            const persona = personaDetails.get(personaId);
            const isStart = index === 0;
            const isEnd = index === path.length - 1;

            pathNodes.push({
              id: `${personaId}`,
              data: { 
                label: `${persona.Nombre} ${persona.Apellidos}`,
              },
              position: { x: 0, y: 0 }, // dagre lo posicionará
              style: {
                background: isStart || isEnd ? '#10b981' : '#334155',
                color: '#fff',
                border: isStart || isEnd ? '3px solid #059669' : '2px solid #64748b',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '14px',
                fontWeight: 'bold',
              },
            });

            if (index < path.length - 1) {
              const nextPersonaId = path[index + 1];
              const relation = adjacencyMap.get(personaId).find(r => r.id === nextPersonaId);
              const tipoRelacion = relation ? relation.tipo : 'Relacionado';
              
              pathEdges.push({
                id: `e${personaId}-${nextPersonaId}`,
                source: `${personaId}`,
                target: `${nextPersonaId}`,
                label: tipoRelacion,
                categoria: relation ? relation.categoria : 'familiar',
                ...createEdgeStyle(tipoRelacion, true, true),
              });
            }
          });

          const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(pathNodes, pathEdges);
          setFoundPath({ nodes: layoutedNodes, edges: layoutedEdges, path });
          setNodes(layoutedNodes);
          setEdges(layoutedEdges);
          setLoading(false);
          return path;
        }

        const neighbors = adjacencyMap.get(current) || [];
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor.id)) {
            visited.add(neighbor.id);
            queue.push([...path, neighbor.id]);
          }
        }
      }

      setPathError('No se encontró conexión entre estas dos personas');
      setLoading(false);
      return null;
    } catch (error) {
      console.error('Error buscando camino:', error);
      setLoading(false);
      return null;
    }
  };

  const onDownload = async () => {
    const nodes = getNodes();
    if (nodes.length === 0) return;

    setIsDownloading(true);
    try {
      // 1. Calcular los límites de todos los nodos en el grafo
      const nodesBounds = getNodesBounds(nodes);
      
      // 2. Definir dimensiones de la imagen (con margen)
      const padding = 50;
      const width = nodesBounds.width + padding * 2;
      const height = nodesBounds.height + padding * 2;

      // 3. Obtener el elemento del viewport de ReactFlow
      const viewportElement = document.querySelector('.react-flow__viewport');
      if (!viewportElement) throw new Error('No se encontró el viewport de ReactFlow');

      // 4. Capturar la imagen
      const dataUrl = await toPng(viewportElement, {
        backgroundColor: '#0f172a',
        width: width,
        height: height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          // Transformar la vista para que encaje el árbol completo en el centro
          transform: `translate(${-nodesBounds.x + padding}px, ${-nodesBounds.y + padding}px)`,
        },
      });

      const fileName = `arbol-genealogico-${selectedPersona ? selectedPersona.Nombre : 'completo'}.png`;
      download(dataUrl, fileName);
      setIsDownloading(false);
    } catch (err) {
      console.error('Error al descargar la imagen completa:', err);
      setIsDownloading(false);
      alert('Hubo un error al generar la imagen completa. Inténtalo de nuevo.');
    }
  };

  // Filtrar edges y nodos según el tipo de relación seleccionado
  const filterGraphByType = (nodes, edges, keepNodeId = null) => {
    let filteredEdges = edges;

    // 1. Filtrar por categoría (familiar/otro)
    if (relationFilter === 'familiar') {
      filteredEdges = edges.filter(edge => edge.categoria === 'familiar');
    } else if (relationFilter === 'other') {
      filteredEdges = edges.filter(edge => edge.categoria !== 'familiar');
    }

    // 2. Filtrar por grado de parentesco (flexible para etiquetas compuestas)
    filteredEdges = filteredEdges.filter(edge => {
      const tipo = (edge.tipo_relacion || edge.label || '').toLowerCase().trim();
      
      // Intentar encontrar mapeo directo o de partes (para etiquetas como "Padre/Madre")
      let mapping = KINSHIP_MAPPING[tipo];
      if (!mapping && tipo.includes('/')) {
        const parts = tipo.split('/');
        for (const part of parts) {
          const p = part.trim().toLowerCase();
          if (KINSHIP_MAPPING[p]) {
            mapping = KINSHIP_MAPPING[p];
            break;
          }
        }
      }
      
      // Si el tipo de relación tiene un mapeo de grado, lo mostramos si está seleccionado
      if (mapping) {
        return selectedDegrees.includes(mapping.filterKey);
      }
      
      // Si no hay mapeo, por seguridad la mostramos si no hay filtros o si es una relación familiar básica
      return true; 
    });
    
    // Obtener los IDs de nodos que están conectados en los edges filtrados
    const connectedNodeIds = new Set();
    filteredEdges.forEach(edge => {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    });
    
    // Filtrar nodos para mostrar solo los que están conectados (o el nodo que queremos forzar)
    const filteredNodes = nodes.filter(node => 
      connectedNodeIds.has(node.id) || (keepNodeId && node.id.toString() === keepNodeId.toString())
    );
    
    return { filteredNodes, filteredEdges };
  };

  const buildNode = (persona) => {
    return {
      id: `${persona.id}`,
      type: 'persona',
      data: {
        nombre: `${persona.Nombre} ${persona.Apellidos}`,
        birth: persona.FechaNacimiento,
        death: persona.FechaDefuncion,
      },
      position: { x: 0, y: 0 },
    };
  };


  const buildNetworkDataset = ({ allPersonas, allRelaciones, personaMap, personaId = null }) => {
    const isFocused = Boolean(personaId);
    const processedRelations = new Set();

    if (!isFocused) {
      const rawNodes = allPersonas.map((persona) => buildNode(persona));
      const rawEdges = [];

      allRelaciones.forEach((rel) => {
        const edgeId = `e${rel.persona_id}-${rel.persona_relacionada_id}`;
        if (processedRelations.has(edgeId)) return;
        processedRelations.add(edgeId);

        rawEdges.push({
          id: edgeId,
          source: `${rel.persona_id}`,
          target: `${rel.persona_relacionada_id}`,
          label: rel.tipo_relacion,
          categoria: rel.categoria,
          ...createEdgeStyle(rel.tipo_relacion, false, true),
        });
      });

      const filtered = filterGraphByType(rawNodes, rawEdges, null);
      return {
        nodes: filtered.filteredNodes,
        edges: filtered.filteredEdges,
        levelMap: null,
      };
    }

    const adjacencyMap = new Map();
    allRelaciones.forEach((rel) => {
      if (!adjacencyMap.has(rel.persona_id)) adjacencyMap.set(rel.persona_id, []);
      adjacencyMap.get(rel.persona_id).push(rel);
    });

    const maxLevels = showExtendedNetwork ? 10 : 1;
    const visitedIds = new Set([personaId]);
    const queue = [{ id: personaId, level: 0 }];
    const rawEdges = [];

    while (queue.length) {
      const { id: currentId, level } = queue.shift();
      if (level >= maxLevels) continue;

      const relaciones = adjacencyMap.get(currentId) || [];
      relaciones.forEach((rel) => {
        const relatedId = rel.persona_relacionada_id;
        const edgeId = `e${currentId}-${relatedId}`;

        if (!visitedIds.has(relatedId)) {
          visitedIds.add(relatedId);
          if (showExtendedNetwork) {
            queue.push({ id: relatedId, level: level + 1 });
          }
        }

        if (processedRelations.has(edgeId)) return;
        processedRelations.add(edgeId);

        if (isFocused) {
          if (currentId !== personaId && relatedId === personaId) {
            return;
          }
        }

        rawEdges.push({
          id: edgeId,
          source: `${currentId}`,
          target: `${relatedId}`,
          label: rel.tipo_relacion,
          categoria: rel.categoria,
          ...createEdgeStyle(rel.tipo_relacion, level === 0, true),
        });
      });
    }

    const rawNodes = Array.from(visitedIds)
      .map((id) => personaMap.get(id))
      .filter(Boolean)
      .map((persona) => buildNode(persona));

    const filtered = filterGraphByType(rawNodes, rawEdges, personaId);
    return {
      nodes: filtered.filteredNodes,
      edges: filtered.filteredEdges,
      levelMap: null,
    };
  };

  const buildTreeDataset = ({ allPersonas, allRelaciones, personaId = null }) => {
    const { generationalEdges, lateralEdges } = buildTreeEdgesFromRelations(allRelaciones, allPersonas);
    const isFocused = Boolean(personaId);

    const createLateralEdge = ({ source, target, label, tipo_relacion }) => {
      const lateralStyle = createEdgeStyle(tipo_relacion, false);
      return {
        id: `tl${source}-${target}`,
        source,
        target,
        label,
        categoria: 'familiar',
        type: 'smoothstep',
        ...lateralStyle,
        markerEnd: undefined,
        sourceHandle: 'right-source',
        targetHandle: 'left-target',
        style: {
          ...lateralStyle.style,
          opacity: 0.9,
          strokeWidth: 4,
        },
      };
    };

    const allPotentialNodes = allPersonas.map((persona) => buildNode(persona));
    const allPotentialEdges = [
      ...generationalEdges.map(({ source, target, label, tipo_relacion, offset }) => ({
        id: `te${source}-${target}-${tipo_relacion.toLowerCase()}`,
        source,
        target,
        label,
        offset, // Crucial para el posicionamiento vertical
        categoria: 'familiar',
        sourceHandle: 'bottom',
        targetHandle: 'top',
        ...createEdgeStyle(tipo_relacion, false, false),
      })),
      ...lateralEdges.map(createLateralEdge)
    ];

    // 2. Aplicar el filtro de GRADOS de parentesco primero
    const { filteredNodes: degreeFilteredNodes, filteredEdges: degreeFilteredEdges } = filterGraphByType(allPotentialNodes, allPotentialEdges, isFocused ? personaId : null);

    // 3. Si hay una persona seleccionada, nos quedamos SOLO con sus vínculos directos (según grados)
    if (isFocused) {
      const startNodeId = `${personaId}`;
      
      // 1. Ampliar el conjunto de nodos para el modo árbol (incluir abuelos/nietos si están en los datos)
      const directNeighborIds = new Set();
      
      const depth = showExtendedNetwork ? 5 : 1;
      let currentLevelNodes = [startNodeId];
      const visited = new Set([startNodeId]);

      for (let i = 0; i < depth; i++) {
        const nextLevelNodes = [];
        degreeFilteredEdges.forEach((edge) => {
          const s = edge.source.toString();
          const t = edge.target.toString();
          
          if (currentLevelNodes.includes(s) && !visited.has(t)) {
            directNeighborIds.add(t);
            nextLevelNodes.push(t);
            visited.add(t);
          } else if (currentLevelNodes.includes(t) && !visited.has(s)) {
            directNeighborIds.add(s);
            nextLevelNodes.push(s);
            visited.add(s);
          }
        });
        currentLevelNodes = nextLevelNodes;
      }

      const finalNodeIds = new Set([...directNeighborIds, startNodeId]);
      const nodesInView = degreeFilteredNodes.filter(n => finalNodeIds.has(n.id.toString()));
      const edgesInView = degreeFilteredEdges.filter(e => finalNodeIds.has(e.source.toString()) && finalNodeIds.has(e.target.toString()));

      const levelMap = buildGenerationalLevels(nodesInView.map(n => n.id), edgesInView.filter(e => e.id.startsWith('te')), startNodeId);

      return {
        nodes: nodesInView,
        edges: edgesInView,
        levelMap,
      };
    }

    // 5. MODO GLOBAL
    const levelMap = buildGenerationalLevels(degreeFilteredNodes.map(n => n.id), degreeFilteredEdges.filter(e => e.id.startsWith('te')));

    return {
      nodes: degreeFilteredNodes,
      edges: degreeFilteredEdges,
      levelMap,
    };
  };

  const buildGraphView = async ({ personaId = null, mode = graphMode } = {}) => {
    setLoading(true);
    // Limpiar nodos y aristas actuales para forzar un re-render limpio del layout
    setNodes([]);
    setEdges([]);
    
    try {
      const graphData = await fetchGraphData();
      const dataset = mode === 'tree'
        ? buildTreeDataset({ ...graphData, personaId })
        : buildNetworkDataset({ ...graphData, personaId });

      const layouted = mode === 'tree'
        ? getHierarchicalLayoutedElements(dataset.nodes, dataset.edges, dataset.levelMap || new Map())
        : getLayoutedElements(dataset.nodes, dataset.edges);

      // Pequeño timeout para asegurar que el canvas se ha limpiado antes de inyectar los nuevos datos
      setTimeout(() => {
        // Ajustar handles laterales y de unión según la posición relativa
        let finalNodes = layouted.nodes;
        let finalEdges = layouted.edges.map(edge => {
          const isLateral = edge.id.startsWith('tl');

          if (isLateral) {
            const sourceNode = finalNodes.find(n => n.id === edge.source);
            const targetNode = finalNodes.find(n => n.id === edge.target);
            
            if (sourceNode && targetNode) {
              // Si el source está a la derecha del target, invertimos handles
              if (sourceNode.position.x > targetNode.position.x) {
                return { ...edge, sourceHandle: 'left-source', targetHandle: 'right-target' };
              }
            }
          }
          return edge;
        });

        setNodes(finalNodes);
        setEdges(finalEdges);
        setLoading(false);
      }, 50);
    } catch (error) {
      console.error('Error construyendo visualización de relaciones:', error);
      setLoading(false);
    }
  };

  const handlePersonaSelect = (e) => {
    const personaId = parseInt(e.target.value);
    setSelectedPersona(personaId);
    if (personaId) {
      buildGraphView({ personaId });
    }
  };


  const handleShowAll = () => {
    setShowAllRelations(true);
    setSelectedPersona(null);
    buildGraphView();
  };

  // Auto-cargar el grafo cuando hay un ID inicial y las personas están cargadas
  useEffect(() => {
    if (initialPersonaId && personas.length > 0) {
      const persona = personas.find(p => p.id === parseInt(initialPersonaId));
      if (persona) {
        setSelectedPersona(persona.id);
        setGraphMode('network');
        setShowExtendedNetwork(false); // mostrar solo adyacentes directos
        buildGraphView({ personaId: persona.id, mode: 'network' });
      }
    }
  }, [initialPersonaId, personas.length]);

  const handleClear = () => {
    setNodes([]);
    setEdges([]);
    setSelectedPersona(null);
    setShowAllRelations(false);
    setFoundPath(null);
    setPathError(null);
    setPathStart(null);
    setPathEnd(null);
  };

  const handleFindPath = () => {
    if (pathStart && pathEnd) {
      findPath(pathStart, pathEnd);
    }
  };

  const handleShowPathFinder = () => {
    setShowPathFinder(true);
    setShowExtendedNetwork(false);
    setSelectedPersona(null);
    setShowAllRelations(false);
    setNodes([]);
    setEdges([]);
    setFoundPath(null);
    setPathError(null);
  };

  // Efecto para recargar el grafo cuando cambie el filtro o el modo de visualización
  useEffect(() => {
    if (selectedPersona) {
      buildGraphView({ personaId: selectedPersona });
    } else if (showAllRelations) {
      buildGraphView();
    }
  }, [relationFilter, showExtendedNetwork, graphMode, selectedDegrees]);


  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-white mb-4">Grafo de Relaciones</h2>
        
        <div className="flex gap-4 mb-4 flex-wrap">
          {/* Selector de modo de grafo */}
          <div className="bg-slate-800 p-1 rounded-lg border border-slate-700 flex">
            <button
              onClick={() => {
                setGraphMode('network');
                setShowExtendedNetwork(false);
                setFoundPath(null);
              }}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${
                graphMode === 'network'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-slate-700'
              }`}
            >
              Grafo de relaciones
            </button>
            <button
              onClick={() => {
                setGraphMode('tree');
                // Ya no forzamos Red Completa para permitir el modo "Solo Adyacentes" solicitado
                setShowPathFinder(false);
                setFoundPath(null);
                // Forzamos la llamada directa para asegurar el cambio inmediato
                buildGraphView({ personaId: selectedPersona, mode: 'tree' });
              }}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${
                graphMode === 'tree'
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-300 hover:bg-slate-700'
              }`}
            >
              Árbol genealógico
            </button>
          </div>

          {/* Selector de persona */}
          <SearchableSelect
            options={personas.map(p => ({ label: `${p.Nombre} ${p.Apellidos}`, value: p.id }))}
            value={selectedPersona}
            onChange={(val) => handlePersonaSelect({ target: { value: val } })}
            placeholder="Selecciona una persona..."
            className="bg-slate-700 border-slate-600 min-w-[250px]"
          />

          {/* Botón ver todas las relaciones */}
          <button
            onClick={handleShowAll}
            className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-lg transition-colors"
          >
            Ver Todas las Relaciones
          </button>

          {/* Botón limpiar */}
          <button
            onClick={handleClear}
            className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-lg transition-colors"
          >
            Limpiar
          </button>

          {/* Botón buscador de caminos */}
          <button
            onClick={handleShowPathFinder}
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg transition-colors flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 9l3 3m0 0l-3 3m3-3H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Buscar Conexión
          </button>

          {/* Botón expandir/contraer */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="bg-slate-600 hover:bg-slate-700 text-white px-6 py-2 rounded-lg transition-colors flex items-center gap-2"
          >
            {isExpanded ? (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Contraer
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
                Expandir
              </>
            )}
          </button>
        </div>

        <p className="text-gray-400 text-sm mb-4">
          {graphMode === 'tree'
            ? 'Modo árbol: se muestra jerarquía por generaciones (padre/madre-hijo) y también relaciones familiares laterales como cónyuges o hermanos.'
            : 'Modo grafo: se muestran todas las relaciones con estilo por tipo.'}
        </p>

        {/* Buscador de caminos entre personas */}
        {showPathFinder && (
          <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 mb-4">
            <h3 className="text-white font-semibold mb-3">Buscar conexión entre dos personas:</h3>
            <div className="flex gap-4 flex-wrap items-end">
              <div>
                <label className="text-gray-300 text-sm mb-1 block">Persona inicial:</label>
                <SearchableSelect
                  options={personas.map(p => ({ label: `${p.Nombre} ${p.Apellidos}`, value: p.id }))}
                  value={pathStart}
                  onChange={(val) => setPathStart(val)}
                  placeholder="Selecciona..."
                  className="bg-slate-700 border-slate-600 min-w-[200px]"
                />
              </div>
              
              <div>
                <label className="text-gray-300 text-sm mb-1 block">Persona final:</label>
                <SearchableSelect
                  options={personas.map(p => ({ label: `${p.Nombre} ${p.Apellidos}`, value: p.id }))}
                  value={pathEnd}
                  onChange={(val) => setPathEnd(val)}
                  placeholder="Selecciona..."
                  className="bg-slate-700 border-slate-600 min-w-[200px]"
                />
              </div>

              <button
                onClick={handleFindPath}
                disabled={!pathStart || !pathEnd}
                className={`px-6 py-2 rounded-lg font-medium transition-colors ${
                  pathStart && pathEnd
                    ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    : 'bg-slate-600 text-gray-400 cursor-not-allowed'
                }`}
              >
                Buscar Camino
              </button>
            </div>
            
            {(foundPath || pathError) && (
              <div className={`mt-4 p-3 border rounded-lg ${
                foundPath 
                  ? 'bg-green-900/30 border-green-700' 
                  : 'bg-red-900/30 border-red-700'
              }`}>
                {foundPath ? (
                  <>
                    <p className="text-green-300 font-semibold">
                      ✓ Camino encontrado: {foundPath.path.length} persona(s) en el camino
                    </p>
                    <p className="text-green-200 text-sm mt-1">
                      {foundPath.path.map((id) => {
                        const persona = personas.find(p => p.id === id);
                        return persona ? `${persona.Nombre} ${persona.Apellidos}` : id;
                      }).join(' → ')}
                    </p>
                  </>
                ) : (
                  <p className="text-red-300 font-semibold flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    {pathError}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Modo de visualización (solo visible cuando hay una persona seleccionada) */}
        {selectedPersona && (
          <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 mb-4">
            <h3 className="text-white font-semibold mb-3">Modo de visualización:</h3>
            <div className="flex gap-3 flex-wrap">
              <button
                onClick={() => setShowExtendedNetwork(false)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  !showExtendedNetwork
                    ? 'bg-green-600 text-white'
                    : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                }`}
              >
                Solo Adyacentes
              </button>
              <button
                onClick={() => setShowExtendedNetwork(true)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  showExtendedNetwork
                    ? 'bg-green-600 text-white'
                    : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                }`}
              >
                Red Completa
              </button>
            </div>
            <p className="text-gray-400 text-sm mt-2">
              {!showExtendedNetwork
                  ? 'Mostrando solo las relaciones directas de la persona seleccionada'
                  : 'Mostrando toda la red de relaciones (parientes de parientes)'}
            </p>
          </div>
        )}

        {/* Filtro de tipo de relación */}
        <div className="flex flex-col md:flex-row gap-4 mb-4">
          <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 flex-1">
            <h3 className="text-white font-semibold mb-3">Filtrar por tipo:</h3>
            {graphMode === 'tree' ? (
              <p className="text-emerald-300 text-sm">
                En modo árbol se aplican relaciones familiares: las parentales definen la jerarquía y las demás (cónyuges, hermanos, etc.) se dibujan como conexiones laterales.
              </p>
            ) : (
              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={() => setRelationFilter('all')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    relationFilter === 'all'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  Todas las relaciones
                </button>
                <button
                  onClick={() => setRelationFilter('familiar')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    relationFilter === 'familiar'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  Solo Familiares
                </button>
                <button
                  onClick={() => setRelationFilter('other')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    relationFilter === 'other'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  Solo Otras
                </button>
              </div>
            )}
          </div>

          {/* Filtro por Grado de Parentesco */}
          <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 flex-1 relative">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Filter size={16} /> Grado de Parentesco:
            </h3>
            
            <div className="relative">
              <button
                onClick={() => setShowDegreeFilter(!showDegreeFilter)}
                className="w-full flex items-center justify-between bg-slate-700 border border-slate-600 text-white px-4 py-2 rounded-lg hover:bg-slate-600 transition-colors"
              >
                <span className="truncate">
                  {selectedDegrees.length === 0 
                    ? "Seleccionar grados..." 
                    : `${selectedDegrees.length} grado(s) seleccionado(s)`}
                </span>
                <ChevronDown size={18} className={`transition-transform ${showDegreeFilter ? 'rotate-180' : ''}`} />
              </button>

              {showDegreeFilter && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 border border-slate-600 rounded-xl shadow-2xl z-[100] max-h-[350px] overflow-hidden flex flex-col">
                  {/* Buscador interno */}
                  <div className="p-2 border-b border-slate-700 bg-slate-800/95 sticky top-0 flex flex-col gap-2">
                    <input
                      type="text"
                      placeholder="Buscar grado (ej: 3º, afinidad...)"
                      value={degreeSearchTerm}
                      onChange={(e) => setDegreeSearchTerm(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-600 text-white text-xs px-3 py-2 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const allKeys = Array.from(new Set(Object.values(KINSHIP_MAPPING).map(m => m.filterKey)));
                          setSelectedDegrees(allKeys);
                        }}
                        className="flex-1 bg-slate-700 hover:bg-slate-600 text-[10px] text-gray-300 py-1 rounded border border-slate-600 transition-colors"
                      >
                        SELECCIONAR TODOS
                      </button>
                      <button
                        onClick={() => setSelectedDegrees([])}
                        className="flex-1 bg-slate-700 hover:bg-slate-600 text-[10px] text-gray-300 py-1 rounded border border-slate-600 transition-colors"
                      >
                        LIMPIAR
                      </button>
                    </div>
                  </div>

                  <div className="overflow-y-auto p-2 custom-scrollbar">
                    <div className="pb-2 border-b border-slate-700 mb-2 flex justify-between items-center px-2">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Opciones de grado</span>
                      <button 
                        onClick={() => setSelectedDegrees([])}
                        className="text-[10px] text-blue-400 hover:text-blue-300 font-bold"
                      >
                        LIMPIAR TODO
                      </button>
                    </div>
                    
                    {Array.from(new Set(Object.values(KINSHIP_MAPPING).map(m => m.filterKey)))
                      .filter(key => key.toLowerCase().includes(degreeSearchTerm.toLowerCase()))
                      .sort((a, b) => {
                        const numA = parseInt(a.match(/\d+/)?.[0] || '0');
                        const numB = parseInt(b.match(/\d+/)?.[0] || '0');
                        if (numA !== numB) return numA - numB;
                        return a.localeCompare(b);
                      })
                      .map(key => (
                        <label 
                          key={key} 
                          className="flex items-center gap-3 p-2 hover:bg-slate-700 rounded-lg cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedDegrees.includes(key)}
                            onChange={() => {
                              if (selectedDegrees.includes(key)) {
                                setSelectedDegrees(selectedDegrees.filter(d => d !== key));
                              } else {
                                setSelectedDegrees([...selectedDegrees, key]);
                              }
                            }}
                            className="w-4 h-4 rounded border-slate-500 text-blue-600 focus:ring-blue-500 bg-slate-700"
                          />
                          <span className="text-sm text-gray-200 capitalize">{key}</span>
                        </label>
                      ))}
                    
                    {Array.from(new Set(Object.values(KINSHIP_MAPPING).map(m => m.filterKey)))
                      .filter(key => key.toLowerCase().includes(degreeSearchTerm.toLowerCase())).length === 0 && (
                        <div className="p-4 text-center text-gray-500 text-xs italic">
                          No se encontraron grados coincidentes
                        </div>
                      )
                    }
                  </div>
                </div>
              )}
            </div>

            {selectedDegrees.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {selectedDegrees.map(deg => (
                  <span 
                    key={deg} 
                    className="flex items-center gap-1 bg-blue-900/40 text-blue-300 text-[10px] px-2 py-1 rounded-full border border-blue-800/50"
                  >
                    {deg.split(' de parentesco')[0]}
                    <X 
                      size={12} 
                      className="cursor-pointer hover:text-white" 
                      onClick={() => setSelectedDegrees(selectedDegrees.filter(d => d !== deg))}
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
          </div>
        </div>

        <div className="flex justify-end mb-4">
          <button
            onClick={onDownload}
            disabled={isDownloading || loading || nodes.length === 0}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-bold shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDownloading ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                GENERANDO IMAGEN...
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                DESCARGAR ÁRBOL (PNG)
              </>
            )}
          </button>
        </div>

        {/* Contenedor que será capturado en la imagen */}
        <div ref={graphWrapperRef} className="bg-slate-900 rounded-xl p-4 border border-slate-800">
          {/* Leyenda */}
          <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
              <h3 className="text-white font-semibold text-sm">Leyenda de Parentesco:</h3>
              <button
                onClick={() => setShowEdgeLabels(!showEdgeLabels)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all text-xs font-medium ${
                  showEdgeLabels 
                    ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30' 
                    : 'bg-slate-700 border-slate-600 text-gray-400 hover:bg-slate-600'
                }`}
              >
                {showEdgeLabels ? (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    OCULTAR NOMBRES
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
                    </svg>
                    MOSTRAR NOMBRES
                  </>
                )}
              </button>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 text-[10px]">
              {Object.entries(KINSHIP_COLORS).map(([degree, color]) => {
                const isVisible = visibleDegrees.includes(degree);
                return (
                  <button 
                    key={degree} 
                    onClick={() => {
                      if (isVisible) {
                        setVisibleDegrees(visibleDegrees.filter(d => d !== degree));
                      } else {
                        setVisibleDegrees([...visibleDegrees, degree]);
                      }
                    }}
                    className={`flex items-center gap-2 p-1 rounded hover:bg-slate-700 transition-all ${
                      isVisible ? 'opacity-100' : 'opacity-40'
                    }`}
                  >
                    <div className="w-3 h-3 rounded-full" style={{ background: color }}></div>
                    <span className="text-gray-300 truncate" title={degree}>{degree}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex gap-6 border-t border-slate-700 pt-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-0.5 bg-gray-400"></div>
                <span className="text-gray-300 text-xs font-medium">Consanguinidad (Sólida)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-0.5 border-t-2 border-dashed border-gray-400"></div>
                <span className="text-gray-300 text-xs font-medium">Afinidad (Punteada)</span>
              </div>
            </div>
          </div>

          {/* Canvas del grafo */}
      <div 
        className={`bg-slate-900 rounded-lg border border-slate-700 transition-all duration-300 relative ${
          isExpanded ? 'fixed inset-4 z-50' : ''
        }`} 
        style={{ height: isExpanded ? 'calc(100vh - 2rem)' : '600px' }}
      >
        {/* Botón de cerrar en modo expandido */}
        {isExpanded && (
          <button
            onClick={() => setIsExpanded(false)}
            className="absolute top-4 right-4 z-10 bg-red-600 hover:bg-red-700 text-white p-2 rounded-lg transition-colors shadow-lg"
            title="Cerrar vista expandida"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-400 text-lg">Cargando grafo...</p>
          </div>
        ) : nodes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-400 text-lg">Selecciona una persona o muestra todas las relaciones</p>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges
              .filter(edge => {
                const label = edge.label?.toLowerCase().trim();
                if (!label) return true;
                
                const styleInfo = getEdgeStyle(label);
                const degreeMatch = styleInfo.degree.match(/\d+/);
                const degreeKey = degreeMatch ? `${degreeMatch[0]}º Grado` : styleInfo.degree;
                const normalizedKey = degreeKey === '0º Grado' || degreeKey === '0 Grado' ? 'Grado 0' : degreeKey;
                
                return visibleDegrees.includes(normalizedKey);
              })
              .map(edge => ({
                ...edge,
                label: showEdgeLabels ? edge.label : null
              }))
            }
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodeClick={(event, node) => {
              const personaId = parseInt(node.id);
              const persona = personas.find(p => p.id === personaId);
              if (persona && onViewPersona) {
                onViewPersona(persona);
              }
            }}
            fitView
            attributionPosition="bottom-left"
          >
            <Background color="#334155" gap={16} />
            <Controls />
            <MiniMap 
              nodeColor="#475569"
              maskColor="rgba(0, 0, 0, 0.6)"
            />
          </ReactFlow>
        )}
      </div>
    </div>
    </div>
  );
};

const RelationGraph = (props) => (
  <ReactFlowProvider>
    <RelationGraphInner {...props} />
  </ReactFlowProvider>
);

export default RelationGraph;
