import uvicorn
import os
import re
import uuid
import base64
import logging
import threading
import traceback
import unicodedata
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
import io
import csv
from pydantic import BaseModel, field_validator
from typing import List, Dict, Optional
from dotenv import load_dotenv
from supabase import create_client, Client
from supabase.client import ClientOptions
import httpx
import time
from functools import wraps

# Carga de variables de entorno y configuración de logs
load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Faltan las variables SUPABASE_URL o SUPABASE_KEY en el archivo .env")

# Truco para que no explote con WinError 10035 en Windows local (forzar HTTP/1.1)
if not os.environ.get("VERCEL"):
    client_opts = ClientOptions(postgrest_client_timeout=30)
    # Sesión custom de httpx sin HTTP/2 y con pocos límites para evitar saturar conexiones
    custom_session = httpx.Client(
        http2=False, 
        timeout=30.0, 
        limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
    )
    db: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=client_opts)
    # Metemos la sesión directamente en el cliente postgrest de supabase-py
    db.postgrest.session = custom_session
    logger.info("Supabase configurado para Windows local (HTTP/1.1)")
else:
    db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    logger.info("Supabase configurado de forma estándar para producción en Vercel")

# Intentar importar el servicio de chatbot
CHATBOT_ENABLED = False
try:
    from chatbot_service import get_chatbot_service
    CHATBOT_ENABLED = True
except ImportError as e:
    logger.warning("No se pudo cargar el chatbot (falta dependencias o archivo): %s", e)

# Inicialización de FastAPI
app = FastAPI(
    title="PICUVIMU API", 
    version="2.0.0",
    root_path="/api" if os.environ.get("VERCEL") else ""
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Funciones de ayuda (Helpers)
def _raise(msg: str, code: int = 500):
    raise HTTPException(status_code=code, detail=msg)

# Lock de base de datos para no saturar los sockets en Windows (en Vercel no hace falta)
db_lock = threading.Lock() if not os.environ.get("VERCEL") else None

def _ok(data):
    if hasattr(data, "data"):
        return data.data
    return data

@app.get("/check-env/")
def check_env():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_KEY", "")
    return {
        "url_check": f"{url[:10]}...{url[-5:]}" if url else "MISSING",
        "key_check": f"{key[:5]}...{key[-5:]}" if key else "MISSING",
        "is_vercel": os.environ.get("VERCEL") is not None
    }

def retry_on_socket_error(max_retries=12, delay=0.5):
    # Si estamos en producción (Vercel), no queremos reintentar eternamente
    if os.environ.get("VERCEL"):
        max_retries = 3
        
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            def run_func():
                last_inner_err = None
                for i in range(max_retries):
                    try:
                        return func(*args, **kwargs)
                    except Exception as e:
                        last_inner_err = e
                        err_msg = str(e).lower()
                        if any(x in err_msg for x in ["10035", "blocked", "timeout", "readerror", "connecterror", "connection reset", "remote protocol"]):
                            logger.warning("Reintentando %s (%d/%d) por error de red: %s", func.__name__, i + 1, max_retries, e)
                            time.sleep(delay * (i + 1))
                            continue
                        raise
                raise last_inner_err

            if db_lock:
                with db_lock:
                    return run_func()
            else:
                return run_func()

        return wrapper
    return decorator

# Modelos de Pydantic
class PersonaCreate(BaseModel):
    Nombre: str
    Apellidos: str
    Genero: str

class RelacionRequest(BaseModel):
    tipo_relacion: str
    categoria: str = "familiar"
    persona_relacionada_id: Optional[int] = None
    nombre_nuevo: Optional[str] = None
    apellido_nuevo: Optional[str] = None
    genero_nuevo: Optional[str] = None
    fecha_nac_nuevo: Optional[str] = None
    lugar_nac_nuevo: Optional[str] = None
    fecha_def_nuevo: Optional[str] = None
    lugar_def_nuevo: Optional[str] = None

class ImagenRequest(BaseModel):
    nombre_imagen: str
    imagen_data: str  # base64
    fuente: Optional[str] = None

class AtributoTemporalRequest(BaseModel):
    nombre_atributo: str
    valor: str
    fecha_inicio: Optional[str] = None
    fecha_fin: Optional[str] = None
    notas: Optional[str] = None
    source: Optional[str] = None

    @field_validator("fecha_inicio", "fecha_fin")
    @classmethod
    def validate_fecha(cls, v):
        if v is None or v == "":
            return None
        parts = v.split("-")
        if len(parts) != 3:
            raise ValueError("Formato DD-MM-YYYY")
        
        try:
            day, month, year = int(parts[0]), int(parts[1]), int(parts[2])
            
            # Lógica para fechas parciales (00 para datos que falten)
            if month < 0 or month > 12:
                raise ValueError("Mes inválido (debe estar entre 1 y 12)")
            if day < 0 or day > 31:
                raise ValueError("Día inválido (debe estar entre 1 y 31)")
            
            # Comprobaciones básicas para fechas que sí son completas
            if month > 0 and day > 0:
                # Verificamos los días máximos de cada mes
                if month in [4, 6, 9, 11] and day > 30:
                    raise ValueError(f"El mes {month} solo tiene 30 días")
                if month == 2:
                    is_leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
                    limit = 29 if is_leap else 28
                    if day > limit:
                        raise ValueError(f"Febrero en {year} solo tiene {limit} días en base al año bisiesto")
        except ValueError as e:
            if "invalid literal" in str(e):
                raise ValueError("La fecha debe contener solo números separados por el guión '-'")
            raise e
        
        return v

class SearchFilters(BaseModel):
    search_text: Optional[str] = None
    atributo_filters: Optional[Dict[str, str]] = {}
    filtros_avanzados: Optional[List[Dict]] = []
    genero: Optional[str] = None

class ChatbotQuery(BaseModel):
    question: str
    history: Optional[List[Dict[str, str]]] = []

# Carga de la lista de parentescos inversos
from kinship_data import RELACIONES_INVERSAS


PARENT_TYPES = {"Padre", "Madre", "Padre/madre", "Padrastro", "Madrastra", "Padrastro/madrastra"}
CHILD_TYPES = {"Hijo", "Hija", "Hijo/a", "Hijastro", "Hijastra", "Hijastro/a"}

def remove_accents(s: str) -> str:
    if not s:
        return ""
    return "".join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

def relacion_inversa(tipo: str, genero: Optional[str]) -> Optional[str]:
    tipo_input = remove_accents((tipo or "").strip().lower())
    for key, value in RELACIONES_INVERSAS.items():
        if remove_accents(key.lower()) == tipo_input:
            g = "M" if genero == "Masculino" else "F" if genero == "Femenino" else genero
            if g == "M":
                return value.get("M", value["default"])
            if g == "F":
                return value.get("F", value["default"])
            return value["default"]
    return None

# Endpoints para la gestión de Personas

@app.get("/personas/")
@retry_on_socket_error()
def list_personas():
    try:
        res = _ok(db.table("Persona").select("*, AtributoPersona(*)").execute())
        
        processed = []
        for p in res:
            try:
                p_dict = dict(p)
                atributos = p.get("AtributoPersona", [])
                if not isinstance(atributos, list):
                    atributos = []
                
                # Extraer fechas clave de los atributos (se mantienen para compatibilidad con el grafo)
                p_dict["FechaNacimiento"] = None
                p_dict["FechaDefuncion"] = None
                
                for a in atributos:
                    nombre = (a.get("nombre_atributo") or "").lower()
                    if nombre == "nacimiento":
                        p_dict["FechaNacimiento"] = a.get("fecha_inicio")
                    elif nombre in ["defunción", "defuncion", "fallecimiento"]:
                        p_dict["FechaDefuncion"] = a.get("fecha_inicio")
                
                processed.append(p_dict)
            except Exception as e:
                logger.error("Error procesando persona %s: %s", p.get('id'), e)
                processed.append(dict(p))
            
        return processed
    except Exception as e:
        error_detail = traceback.format_exc()
        logger.error(error_detail)
        raise HTTPException(status_code=500, detail=f"Error en list_personas: {str(e)}\n{error_detail}")

@app.post("/personas/")
@retry_on_socket_error()
def create_persona(persona: PersonaCreate):
    try:
        data = _ok(db.table("Persona").insert({
            "Nombre": persona.Nombre,
            "Apellidos": persona.Apellidos,
            "Genero": persona.Genero,
        }).execute())
        return data[0] if data else {}
    except Exception as e:
        _raise(str(e))

@app.get("/personas/{persona_id}")
@retry_on_socket_error()
def get_persona(persona_id: int):
    try:
        data = _ok(db.table("Persona").select("*").eq("id", persona_id).execute())
        if not data:
            raise HTTPException(status_code=404, detail="Persona no encontrada")
        return data[0]
    except HTTPException:
        raise
    except Exception as e:
        _raise(str(e))

@app.put("/personas/{persona_id}")
@retry_on_socket_error()
def update_persona(persona_id: int, persona: PersonaCreate):
    try:
        data = _ok(db.table("Persona").update({
            "Nombre": persona.Nombre,
            "Apellidos": persona.Apellidos,
            "Genero": persona.Genero,
        }).eq("id", persona_id).execute())
        if not data:
            raise HTTPException(status_code=404, detail="Persona no encontrada")
        return data[0]
    except HTTPException:
        raise
    except Exception as e:
        _raise(str(e))

@app.delete("/personas/{persona_id}")
@retry_on_socket_error()
def delete_persona(persona_id: int):
    try:
        # Eliminar relaciones
        db.table("RelacionPersona").delete().or_(
            f"persona_id.eq.{persona_id},persona_relacionada_id.eq.{persona_id}"
        ).execute()
        # Eliminar imágenes de storage
        imagenes = _ok(db.table("ImagenPersona").select("ruta_archivo").eq("persona_id", persona_id).execute())
        for img in imagenes:
            try:
                db.storage.from_("imagenes").remove([img["ruta_archivo"]])
            except Exception:
                pass
        db.table("AtributoPersona").delete().eq("persona_id", persona_id).execute()
        db.table("ImagenPersona").delete().eq("persona_id", persona_id).execute()
        db.table("Persona").delete().eq("id", persona_id).execute()
        return {"message": "Persona eliminada"}
    except Exception as e:
        _raise(str(e))

def to_accent_insensitive_regex(text: str) -> str:
    replacements = {
        'a': '[aáàäâ]', 'e': '[eéèëê]', 'i': '[iyíìïî]', 'y': '[iyíìïî]', 'o': '[oóòöô]', 'u': '[uúùüû]', 'n': '[nñ]'
    }
    res = ""
    for char in text.lower():
        if char in replacements:
            res += replacements[char]
        elif char.isalpha():
            res += char
        else:
            res += re.escape(char)
    return res

@app.post("/personas/search/")
@retry_on_socket_error()
def search_personas(filters: SearchFilters):
    try:
        query = db.table("Persona").select("*, AtributoPersona(*)")
        
        if filters.genero:
            query = query.eq("Genero", filters.genero)
        if filters.search_text:
            terms = filters.search_text.strip().split()
            for term in terms:
                if term:
                    regex = to_accent_insensitive_regex(term)
                    # En Supabase/Postgrest, usamos .imatch para regex insensible a mayúsculas y acentos (vía regex)
                    query = query.or_(f'"Nombre".imatch.{regex},"Apellidos".imatch.{regex}')
        
        personas = _ok(query.execute())

        if filters.filtros_avanzados:
            # Aplicar filtros de atributos con soporte para fechas
            ids_validos = None
            for f in filters.filtros_avanzados:
                nombre = f.get("nombre_atributo")
                valor = f.get("valor")
                fecha_desde = f.get("fecha_desde")
                fecha_hasta = f.get("fecha_hasta")
                
                if not nombre:
                    continue
                
                q = db.table("AtributoPersona").select("persona_id, fecha_inicio, fecha_fin").eq("nombre_atributo", nombre)
                
                if valor:
                    q = q.ilike("valor", f"%{valor}%")
                
                atrib = _ok(q.execute())
                
                # Función auxiliar para convertir DD-MM-YYYY a YYYYMMDD para comparar
                def date_to_int(d_str):
                    if not d_str: return 0
                    try:
                        parts = str(d_str).split("-")
                        if len(parts) == 1: # Solo año: YYYY
                            return int(parts[0]) * 10000
                        if len(parts) == 2: # Mes y año: MM-YYYY
                            return int(parts[1]) * 10000 + int(parts[0]) * 100
                        if len(parts) == 3: # Fecha completa: DD-MM-YYYY
                            return int(parts[2]) * 10000 + int(parts[1]) * 100 + int(parts[0])
                        return 0
                    except: return 0
                
                ids_atrib = set()
                fd_int = date_to_int(fecha_desde) if fecha_desde else 0
                fh_int = date_to_int(fecha_hasta) if fecha_hasta else 99999999
                
                for a in atrib:
                    f_inicio_int = date_to_int(a.get("fecha_inicio"))
                    if fecha_desde and f_inicio_int < fd_int:
                        continue
                    if fecha_hasta and f_inicio_int > fh_int:
                        continue
                    ids_atrib.add(int(a["persona_id"]))
                
                if ids_validos is None:
                    ids_validos = ids_atrib
                else:
                    ids_validos = ids_validos & ids_atrib
            
            if ids_validos is not None:
                personas = [p for p in personas if int(p["id"]) in ids_validos]

        processed = []
        for p in personas:
            try:
                p_dict = dict(p)
                atributos = p.get("AtributoPersona", [])
                if not isinstance(atributos, list):
                    atributos = []
                
                # Extraer fechas clave de los atributos (se mantienen para compatibilidad con el grafo)
                p_dict["FechaNacimiento"] = None
                p_dict["FechaDefuncion"] = None
                
                for a in atributos:
                    nombre = (a.get("nombre_atributo") or "").lower()
                    if nombre == "nacimiento":
                        p_dict["FechaNacimiento"] = a.get("fecha_inicio")
                    elif nombre in ["defunción", "defuncion", "fallecimiento"]:
                        p_dict["FechaDefuncion"] = a.get("fecha_inicio")
                
                processed.append(p_dict)
            except Exception as e:
                logger.error("Error procesando persona %s: %s", p.get('id'), e)
                processed.append(dict(p))

        return processed
    except Exception as e:
        _raise(str(e))

# Endpoints para controlar las Relaciones entre personas

@app.get("/relaciones/todas/")
@retry_on_socket_error()
def get_todas_relaciones():
    try:
        return _ok(db.table("RelacionPersona").select("*").execute())
    except Exception:
        return []

@app.get("/relaciones/tipos/")
@retry_on_socket_error()
def get_tipos_relaciones(categoria: Optional[str] = None):
    try:
        query = db.table("RelacionPersona").select("tipo_relacion")
        if categoria:
            query = query.eq("categoria", categoria)
        data = _ok(query.execute())
        # Extraer tipos únicos + tipos predefinidos
        tipos = {r["tipo_relacion"] for r in data}
        tipos.update(RELACIONES_INVERSAS.keys())
        return {"tipos_relaciones": sorted(list(tipos))}
    except Exception as e:
        # Si la tabla no existe aún, devolver al menos los predefinidos
        return {"tipos_relaciones": sorted(list(RELACIONES_INVERSAS.keys()))}

@app.get("/personas/{persona_id}/relaciones/")
@retry_on_socket_error()
def get_relaciones(persona_id: int):
    try:
        relaciones = _ok(db.table("RelacionPersona").select("*").eq("persona_id", persona_id).execute())
        if not relaciones: return []
            
        # Optimización: Obtener todos los IDs de personas relacionadas
        related_ids = [rel["persona_relacionada_id"] for rel in relaciones]
        personas_res = _ok(db.table("Persona").select("*").in_("id", related_ids).execute())
        persona_map = {p["id"]: p for p in personas_res}
        
        result = []
        for rel in relaciones:
            result.append({
                "id": rel["id"],
                "tipo_relacion": rel["tipo_relacion"],
                "categoria": rel["categoria"],
                "persona_relacionada": persona_map.get(rel["persona_relacionada_id"], {}),
            })
        return result
    except Exception as e:
        _raise(str(e))

@app.post("/personas/{persona_id}/relaciones/")
def add_relacion(persona_id: int, relacion: RelacionRequest):
    try:
        # Normalizar tipo de relación
        tipo_norm = (relacion.tipo_relacion or "").strip().capitalize()
        
        # Determinar dirección generacional (si la hay)
        parent_id, child_id = None, None
        if tipo_norm in PARENT_TYPES:
            parent_id, child_id = persona_id, relacion.persona_relacionada_id
        elif tipo_norm in CHILD_TYPES:
            parent_id, child_id = relacion.persona_relacionada_id, persona_id

        # Verificar ciclos si es una relación generacional
        if parent_id is not None and child_id is not None:
            queue = [child_id]
            visited = {child_id}
            while queue:
                curr = queue.pop(0)
                if curr == parent_id:
                    raise HTTPException(status_code=400, detail="Relación circular detectada: una persona no puede ser ancestro y descendiente a la vez.")
                rels = _ok(db.table("RelacionPersona").select("*").eq("persona_id", curr).execute())
                for r in rels:
                    t = (r["tipo_relacion"] or "").strip().capitalize()
                    if t in PARENT_TYPES:
                        nxt = r["persona_relacionada_id"]
                        if nxt not in visited:
                            visited.add(nxt)
                            queue.append(nxt)

        # Crear persona nueva si hace falta
        pid_rel = relacion.persona_relacionada_id
        if pid_rel is None:
            nueva = _ok(db.table("Persona").insert({
                "Nombre": relacion.nombre_nuevo or "",
                "Apellidos": relacion.apellido_nuevo or "",
                "Genero": relacion.genero_nuevo,
            }).execute())
            pid_rel = nueva[0]["id"]
            
            # Crear atributos biográficos para la nueva persona si se proporcionan
            now_iso = datetime.now().isoformat()
            if relacion.fecha_nac_nuevo or relacion.lugar_nac_nuevo:
                db.table("AtributoPersona").insert({
                    "persona_id": pid_rel,
                    "nombre_atributo": "Nacimiento",
                    "valor": relacion.lugar_nac_nuevo or "Desconocido",
                    "fecha_inicio": relacion.fecha_nac_nuevo,
                    "created_at": now_iso,
                    "updated_at": now_iso
                }).execute()
            
            if relacion.fecha_def_nuevo or relacion.lugar_def_nuevo:
                db.table("AtributoPersona").insert({
                    "persona_id": pid_rel,
                    "nombre_atributo": "Defunción",
                    "valor": relacion.lugar_def_nuevo or "Desconocido",
                    "fecha_inicio": relacion.fecha_def_nuevo,
                    "created_at": now_iso,
                    "updated_at": now_iso
                }).execute()

            # Si acabamos de crear la persona, actualizamos child_id si era el destino
            if tipo_norm in PARENT_TYPES:
                child_id = pid_rel
            elif tipo_norm in CHILD_TYPES:
                parent_id = pid_rel

        # Insertar relación directa
        db.table("RelacionPersona").insert({
            "persona_id": persona_id,
            "persona_relacionada_id": pid_rel,
            "tipo_relacion": tipo_norm,
            "categoria": relacion.categoria,
        }).execute()

        # Insertar relación inversa automáticamente.
        # El género que determina el tipo inverso es el de la persona DESTINO (pid_rel),
        # ya que será el ORIGEN de la relación inversa.
        p_rel_info = _ok(db.table("Persona").select("Genero").eq("id", pid_rel).execute())
        genero_rel_inv = p_rel_info[0]["Genero"] if p_rel_info else None
        inv = relacion_inversa(tipo_norm, genero_rel_inv)
        
        if inv:
            # Evitar duplicados: no insertar si ya existe la inversa
            existente = _ok(
                db.table("RelacionPersona")
                .select("id")
                .eq("persona_id", pid_rel)
                .eq("persona_relacionada_id", persona_id)
                .eq("tipo_relacion", inv)
                .execute()
            )
            if not existente:
                db.table("RelacionPersona").insert({
                    "persona_id": pid_rel,
                    "persona_relacionada_id": persona_id,
                    "tipo_relacion": inv,
                    "categoria": relacion.categoria,
                }).execute()

        return {"message": "Relación añadida", "persona_relacionada_id": pid_rel}
    except HTTPException:
        # Re-lanzar excepciones HTTP conocidas (como las de circularidad)
        raise
    except Exception as e:
        _raise(str(e))

@app.delete("/relaciones/{relacion_id}")
@retry_on_socket_error()
def delete_relacion(relacion_id: int):
    try:
        rel = _ok(db.table("RelacionPersona").select("*").eq("id", relacion_id).execute())
        if not rel:
            raise HTTPException(status_code=404, detail="Relación no encontrada")
        rel = rel[0]
        persona_id = rel["persona_id"] # ID de la persona origen
        pid_rel = rel["persona_relacionada_id"] # ID de la persona relacionada
        tipo = rel["tipo_relacion"]

        # Borrar relación directa
        db.table("RelacionPersona").delete().eq("id", relacion_id).execute()

        # Borrar relación inversa usando el género de la persona relacionada
        if rel.get("categoria") == "familiar":
            p_rel_info = _ok(db.table("Persona").select("Genero").eq("id", pid_rel).execute())
            genero_rel_inv = p_rel_info[0]["Genero"] if p_rel_info else None
            inv = relacion_inversa(tipo, genero_rel_inv)
            if inv:
                db.table("RelacionPersona").delete()\
                    .eq("persona_id", pid_rel)\
                    .eq("persona_relacionada_id", persona_id)\
                    .eq("tipo_relacion", inv)\
                    .execute()

        return {"message": "Relación eliminada"}
    except HTTPException:
        raise
    except Exception as e:
        _raise(str(e))

# Endpoints para subir y servir imágenes de las personas

if os.environ.get("VERCEL"):
    IMAGENES_DIR = Path("/tmp/imagenes")
else:
    # Ruta absoluta relativa al archivo main.py para mayor robustez
    IMAGENES_DIR = Path(__file__).parent.parent / "data" / "imagenes"

@app.post("/personas/{persona_id}/imagenes/")
@retry_on_socket_error()
def add_imagen_persona(persona_id: int, imagen: ImagenRequest):
    try:
        # Check size to avoid Vercel 4.5MB limit (approx 6MB base64)
        if len(imagen.imagen_data) > 6000000:
            _raise("La imagen es demasiado grande para el servidor. Intenta con una imagen de menos de 4MB.", 413)

        # Log del tamaño del payload para diagnóstico
        logger.info("Recibida imagen para persona %d. Tamaño base64: %d caracteres.", persona_id, len(imagen.imagen_data))
        if "," in imagen.imagen_data:
            header, b64 = imagen.imagen_data.split(",", 1)
            ext = "jpg"
            if "png" in header: ext = "png"
            elif "webp" in header: ext = "webp"
        else:
            b64, ext = imagen.imagen_data, "jpg"

        img_bytes = base64.b64decode(b64)
        nombre_archivo = f"persona_{persona_id}_{uuid.uuid4().hex[:8]}.{ext}"

        # Siempre guardar localmente como backup/fallback
        try:
            IMAGENES_DIR.mkdir(parents=True, exist_ok=True)
            (IMAGENES_DIR / nombre_archivo).write_bytes(img_bytes)
        except Exception as e:
            logger.warning("Error guardando imagen localmente: %s", e)

        # Intentar subir a Supabase Storage
        url = f"/imagenes/{nombre_archivo}" # Fallback relativo inicial
        try:
            # Añadimos un timeout corto para no bloquear la ejecución si Supabase Storage falla
            db.storage.from_("imagenes").upload(
                path=nombre_archivo,
                file=img_bytes,
                file_options={"content-type": f"image/{ext}", "upsert": "true"},
            )
            # Si tiene éxito, obtenemos la URL pública final
            url = db.storage.from_("imagenes").get_public_url(nombre_archivo)
        except Exception as se:
            logger.warning("Supabase Storage upload falló: %s", se)

        # Insertar en base de datos
        try:
            insert_data = {
                "persona_id": persona_id,
                "nombre_imagen": imagen.nombre_imagen,
                "ruta_archivo": nombre_archivo,
            }
            if imagen.fuente:
                insert_data["fuente"] = imagen.fuente

            logger.info("Insertando imagen en BD: %s", insert_data)
            res = db.table("ImagenPersona").insert(insert_data).execute()
            
            if not res.data or len(res.data) == 0:
                logger.warning("Inserción completada pero no se devolvieron datos (posible RLS).")
                img_id = "new"
            else:
                img_id = res.data[0]["id"]
            
            # Si la URL no es absoluta (Supabase), devolvemos la del proxy local
            if not url or not url.startswith("http"):
                url = f"/imagenes/{img_id}" if img_id != "new" else f"/imagenes/fallback/{nombre_archivo}"
                
            return {
                "id": img_id, 
                "persona_id": persona_id, 
                "nombre_imagen": imagen.nombre_imagen, 
                "fuente": imagen.fuente, 
                "url": url,
                "status": "inserted"
            }
        except Exception as dbe:
            error_msg = str(dbe)
            logger.error("Error insertando imagen en BD: %s", error_msg)
            if "column" in error_msg.lower() and "fuente" in error_msg.lower():
                _raise(f"La base de datos no tiene la columna 'fuente'. Por favor, ejecuta el SQL de actualización: {error_msg}", 400)
            _raise(f"Error al registrar imagen en la base de datos: {error_msg}", 500)

    except Exception as e:
        logger.exception("Error crítico procesando imagen para persona %d", persona_id)
        if isinstance(e, HTTPException):
            raise e
        _raise(f"Error crítico en el servidor al procesar la imagen: {str(e)}", 500)

@app.get("/personas/{persona_id}/imagenes/")
@retry_on_socket_error()
def get_imagenes_persona(persona_id: int):
    try:
        imagenes = _ok(db.table("ImagenPersona").select("*").eq("persona_id", persona_id).execute())
        result = []
        for img in imagenes:
            nombre = img["ruta_archivo"]
            local_path = IMAGENES_DIR / nombre
            
            # Si el archivo existe localmente, devolvemos la URL del proxy local
            # Esto soluciona los errores 403 de Supabase RLS mientras el usuario no los arregle
            if local_path.exists():
                url = f"/imagenes/{img['id']}"
            else:
                # Intentar URL de Supabase como última instancia
                url = db.storage.from_("imagenes").get_public_url(nombre)
                
            result.append({
                "id": img["id"], 
                "persona_id": img["persona_id"], 
                "nombre_imagen": img["nombre_imagen"], 
                "fuente": img.get("fuente"),
                "url": url
            })
        return result
    except Exception as e:
        _raise(str(e))

@app.delete("/imagenes/{imagen_id}")
@retry_on_socket_error()
def delete_imagen(imagen_id: int):
    try:
        img = _ok(db.table("ImagenPersona").select("*").eq("id", imagen_id).execute())
        if not img:
            raise HTTPException(status_code=404, detail="Imagen no encontrada")
        nombre = img[0]["ruta_archivo"]
        try:
            db.storage.from_("imagenes").remove([nombre])
        except Exception:
            pass
        db.table("ImagenPersona").delete().eq("id", imagen_id).execute()
        return {"message": "Imagen eliminada"}
    except HTTPException:
        raise
    except Exception as e:
        _raise(str(e))

@app.get("/imagenes/{imagen_id}")
def get_imagen_file(imagen_id: int):
    try:
        # Buscar la imagen por ID
        res = db.table("ImagenPersona").select("*").eq("id", imagen_id).execute()
        img_data = res.data
        if not img_data:
            raise HTTPException(status_code=404, detail="Imagen no encontrada en BD")
        
        nombre_archivo = img_data[0]["ruta_archivo"]
        
        # Primero intentamos servir local si existe
        ruta_local = IMAGENES_DIR / nombre_archivo
        if ruta_local.exists():
            return FileResponse(ruta_local)
            
        # Si no existe local, redirigimos a Supabase (aunque pueda dar 403 si no hay políticas)
        try:
            url = db.storage.from_("imagenes").get_public_url(nombre_archivo)
            return RedirectResponse(url=url)
        except Exception:
            raise HTTPException(status_code=404, detail="Archivo no encontrado en ninguna ubicación")
            
    except HTTPException:
        raise
    except Exception as e:
        _raise(str(e))

# Endpoints para atributos dinámicos o biográficos

@app.get("/personas/atributos/nombres/")
@retry_on_socket_error()
def get_nombres_atributos():
    try:
        data = _ok(db.table("AtributoPersona").select("nombre_atributo").execute())
        # Filtrar None y convertir a string antes de ordenar
        nombres = sorted(list({str(a["nombre_atributo"]) for a in data if a.get("nombre_atributo")}))
        return {"atributos": nombres}
    except Exception as e:
        logger.error("Error en get_nombres_atributos: %s", e)
        return {"atributos": []}

@app.get("/personas/{persona_id}/atributos/")
@retry_on_socket_error()
def get_atributos_persona(persona_id: int):
    try:
        atributos = _ok(db.table("AtributoPersona").select("*").eq("persona_id", persona_id).execute())
        # Ordenar por fecha_inicio en Python de forma segura
        def fecha_num(f):
            if not f or not isinstance(f, str): return 99999999
            try:
                parts = f.split("-")
                if len(parts) == 3:
                    d, m, y = parts
                    return int(y)*10000 + int(m)*100 + int(d)
                elif len(parts) == 1 and parts[0].isdigit():
                    return int(parts[0])*10000
                return 99999999
            except: return 99999999
            
        def sort_key(x):
            f_num = fecha_num(x.get("fecha_inicio"))
            nombre = str(x.get("nombre_atributo") or "")
            return (f_num, nombre)

        return sorted(atributos, key=sort_key)
    except Exception as e:
        error_detail = traceback.format_exc()
        logger.error(error_detail)
        raise HTTPException(status_code=500, detail=f"Error en get_atributos_persona: {str(e)}\n{error_detail}")

@app.post("/personas/{persona_id}/atributos/")
@retry_on_socket_error()
def create_atributo_persona(persona_id: int, atributo: AtributoTemporalRequest):
    try:
        now = datetime.now().isoformat()
        data = _ok(db.table("AtributoPersona").insert({
            "persona_id": persona_id,
            "nombre_atributo": atributo.nombre_atributo,
            "valor": atributo.valor,
            "fecha_inicio": atributo.fecha_inicio,
            "fecha_fin": atributo.fecha_fin,
            "notas": atributo.notas,
            "source": atributo.source,
            "created_at": now,
            "updated_at": now,
        }).execute())
        return data[0]
    except Exception as e:
        _raise(str(e))

@app.put("/personas/{persona_id}/atributos/{atributo_id}")
@retry_on_socket_error()
def update_atributo_persona(persona_id: int, atributo_id: int, atributo: AtributoTemporalRequest):
    try:
        data = _ok(db.table("AtributoPersona").update({
            "nombre_atributo": atributo.nombre_atributo,
            "valor": atributo.valor,
            "fecha_inicio": atributo.fecha_inicio,
            "fecha_fin": atributo.fecha_fin,
            "notas": atributo.notas,
            "source": atributo.source,
            "updated_at": datetime.now().isoformat(),
        }).eq("id", atributo_id).eq("persona_id", persona_id).execute())
        if not data:
            raise HTTPException(status_code=404, detail="Atributo no encontrado")
        return data[0]
    except HTTPException:
        raise
    except Exception as e:
        _raise(str(e))

@app.delete("/personas/{persona_id}/atributos/{atributo_id}")
@retry_on_socket_error()
def delete_atributo_persona(persona_id: int, atributo_id: int):
    try:
        db.table("AtributoPersona").delete().eq("id", atributo_id).eq("persona_id", persona_id).execute()
        return {"message": "Atributo eliminado"}
    except Exception as e:
        _raise(str(e))

@app.get("/personas/{persona_id}/atributos/{nombre_atributo}/historial")
@retry_on_socket_error()
def get_historial_atributo(persona_id: int, nombre_atributo: str):
    try:
        return _ok(db.table("AtributoPersona").select("*")
            .eq("persona_id", persona_id)
            .eq("nombre_atributo", nombre_atributo)
            .order("fecha_inicio", desc=True)
            .execute())
    except Exception as e:
        _raise(str(e))

# Endpoints para exportar datos en formatos JSON o CSV

@app.get("/export/json")
@retry_on_socket_error()
def export_json():
    try:
        personas = _ok(db.table("Persona").select("*").execute())
        atributos = _ok(db.table("AtributoPersona").select("*").execute())
        relaciones = _ok(db.table("RelacionPersona").select("*").execute())
        
        return {
            "personas": personas,
            "atributos": atributos,
            "relaciones": relaciones,
            "exported_at": datetime.now().isoformat()
        }
    except Exception as e:
        _raise(str(e))

@app.get("/export/csv/personas")
@retry_on_socket_error()
def export_csv_personas():
    try:
        personas = _ok(db.table("Persona").select("*").execute())
        if not personas:
            return StreamingResponse(io.StringIO(""), media_type="text/csv")
        
        output = io.StringIO()
        # Obtener cabeceras de las claves del primer objeto
        headers = list(personas[0].keys())
        writer = csv.DictWriter(output, fieldnames=headers)
        writer.writeheader()
        writer.writerows(personas)
        
        output.seek(0)
        filename = f"personas_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except Exception as e:
        _raise(str(e))

@app.get("/export/csv/relaciones")
@retry_on_socket_error()
def export_csv_relaciones():
    try:
        relaciones = _ok(db.table("RelacionPersona").select("*").execute())
        if not relaciones:
            return StreamingResponse(io.StringIO(""), media_type="text/csv")
        
        output = io.StringIO()
        headers = list(relaciones[0].keys())
        writer = csv.DictWriter(output, fieldnames=headers)
        writer.writeheader()
        writer.writerows(relaciones)
        
        output.seek(0)
        filename = f"relaciones_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except Exception as e:
        _raise(str(e))

# Endpoints para interactuar con el chatbot genealógico

class ChatbotResponse(BaseModel):
    success: bool
    response: str
    sql_query: Optional[str] = None
    results_count: Optional[int] = None
    error: Optional[str] = None

@app.post("/chatbot/query", response_model=ChatbotResponse)
async def chatbot_query(query: ChatbotQuery):
    if not CHATBOT_ENABLED:
        raise HTTPException(status_code=503, detail="Chatbot no disponible")
    try:
        from chatbot_service import get_chatbot_service
        chatbot = get_chatbot_service(db)
        result = chatbot.process_query(query.question, query.history)
        return ChatbotResponse(**result)
    except Exception as e:
        return ChatbotResponse(success=False, response=f"Error: {str(e)}", error=str(e))

@app.get("/chatbot/status")
async def chatbot_status():
    if not CHATBOT_ENABLED:
        return {"enabled": False}
    try:
        from chatbot_service import get_chatbot_service
        chatbot = get_chatbot_service(db)
        return {"enabled": True, "model": chatbot.model_name}
    except Exception as e:
        return {"enabled": False, "error": str(e)}

# Punto de entrada para arrancar el servidor en local
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
