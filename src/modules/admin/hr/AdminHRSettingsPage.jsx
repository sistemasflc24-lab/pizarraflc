import React, { useEffect, useMemo, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import {
    CalendarDays,
    Gift,
    Image as ImageIcon,
    Loader2,
    Megaphone,
    Plus,
    Save,
    Settings,
    Trash2,
    Trophy,
    Upload,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { db, storage } from "../../../firebase";
import {
    createAnnouncementItem,
    createAnniversaryItem,
    createBirthdayItem,
    createVacationItem,
    defaultHrSettings,
} from "../../hr/defaults";

function mergeHrSettings(data = {}) {
    return {
        ...defaultHrSettings,
        ...data,
        vacationsItems: Array.isArray(data.vacationsItems) ? data.vacationsItems : defaultHrSettings.vacationsItems,
        birthdaysItems: Array.isArray(data.birthdaysItems) ? data.birthdaysItems : defaultHrSettings.birthdaysItems,
        anniversariesItems: Array.isArray(data.anniversariesItems) ? data.anniversariesItems : defaultHrSettings.anniversariesItems,
        announcementsItems: Array.isArray(data.announcementsItems) ? data.announcementsItems : defaultHrSettings.announcementsItems,
        slides: Array.isArray(data.slides) ? data.slides : defaultHrSettings.slides,
    };
}

const SectionHeader = ({ icon: Icon, title, description, action }) => (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
        <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                <Icon size={18} className="text-brand-600" />
                {title}
            </h2>
            {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
        </div>
        {action}
    </div>
);

const TextInput = ({ label, value, onChange, placeholder, className = "", ...props }) => (
    <label className={`block ${className}`}>
        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
        <input
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            className="w-full rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            {...props}
        />
    </label>
);

const TextArea = ({ label, value, onChange, placeholder, rows = 3, className = "", ...props }) => (
    <label className={`block ${className}`}>
        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
        <textarea
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            rows={rows}
            className="w-full resize-none rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            {...props}
        />
    </label>
);

export default function AdminHRSettingsPage() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [uploadingKey, setUploadingKey] = useState("");
    const [form, setForm] = useState(defaultHrSettings);

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const docSnap = await getDoc(doc(db, "settings", "hr"));
                if (docSnap.exists()) {
                    setForm(mergeHrSettings(docSnap.data()));
                } else {
                    setForm(defaultHrSettings);
                }
            } catch (error) {
                console.error("Error loading HR settings:", error);
                alert("Error al cargar la configuracion de RH.");
            } finally {
                setLoading(false);
            }
        };

        loadSettings();
    }, []);

    const isUploading = useMemo(() => uploadingKey !== "", [uploadingKey]);

    const updateField = (field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
    };

    const updateCollectionItem = (field, id, patch) => {
        setForm((current) => ({
            ...current,
            [field]: current[field].map((item) => (item.id === id ? { ...item, ...patch } : item)),
        }));
    };

    const addCollectionItem = (field, factory) => {
        setForm((current) => ({ ...current, [field]: [...current[field], factory()] }));
    };

    const removeCollectionItem = (field, id) => {
        setForm((current) => ({ ...current, [field]: current[field].filter((item) => item.id !== id) }));
    };

    const uploadFile = async (folder, file) => {
        const storagePath = `${folder}/${uuidv4()}_${file.name}`;
        const fileRef = ref(storage, storagePath);
        await uploadBytes(fileRef, file);
        const downloadUrl = await getDownloadURL(fileRef);
        return { downloadUrl, storagePath };
    };

    const removeStorageFile = async (storagePath) => {
        if (!storagePath) return;
        await deleteObject(ref(storage, storagePath)).catch((error) => {
            console.warn("Failed to delete storage file", error);
        });
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await setDoc(
                doc(db, "settings", "hr"),
                {
                    ...form,
                    updatedAt: new Date().toISOString(),
                },
                { merge: true },
            );
            alert("Configuracion de RH guardada correctamente.");
        } catch (error) {
            console.error("Error saving HR settings:", error);
            alert(`Error al guardar: ${error.message}`);
        } finally {
            setSaving(false);
        }
    };

    const handleChatBgUpload = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setUploadingKey("chat-bg");
        try {
            const { downloadUrl } = await uploadFile("hr/settings/chat", file);
            updateField("chatBgImage", downloadUrl);
        } catch (error) {
            console.error("Error uploading chat background:", error);
            alert("Error al subir el fondo del chat.");
        } finally {
            setUploadingKey("");
            event.target.value = "";
        }
    };

    const handleSlideUpload = async (event, slideId) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setUploadingKey(`slide-${slideId}`);
        try {
            const { downloadUrl, storagePath } = await uploadFile("hr/newsletter", file);
            updateCollectionItem("slides", slideId, {
                image: downloadUrl,
                path: storagePath,
            });
        } catch (error) {
            console.error("Error uploading slide image:", error);
            alert("Error al subir la imagen del carrusel.");
        } finally {
            setUploadingKey("");
            event.target.value = "";
        }
    };

    const handleAnnouncementUpload = async (event, announcementId) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setUploadingKey(`announcement-${announcementId}`);
        try {
            const currentItem = form.announcementsItems.find((item) => item.id === announcementId);
            await removeStorageFile(currentItem?.imagePath);
            const { downloadUrl, storagePath } = await uploadFile("hr/announcements", file);
            updateCollectionItem("announcementsItems", announcementId, {
                image: downloadUrl,
                imagePath: storagePath,
            });
        } catch (error) {
            console.error("Error uploading announcement image:", error);
            alert("Error al subir la imagen del anuncio.");
        } finally {
            setUploadingKey("");
            event.target.value = "";
        }
    };

    const handleDeleteSlide = async (slide) => {
        if (!confirm("Eliminar esta noticia del carrusel?")) return;
        await removeStorageFile(slide.path);
        removeCollectionItem("slides", slide.id);
    };

    const handleDeleteAnnouncement = async (announcement) => {
        if (!confirm("Eliminar este anuncio?")) return;
        await removeStorageFile(announcement.imagePath);
        removeCollectionItem("announcementsItems", announcement.id);
    };

    const handleRemoveAnnouncementImage = async (announcement) => {
        await removeStorageFile(announcement.imagePath);
        updateCollectionItem("announcementsItems", announcement.id, {
            image: "",
            imagePath: "",
        });
    };

    const handleAddSlide = () => {
        setForm((current) => ({
            ...current,
            slides: [
                {
                    id: uuidv4(),
                    title: "",
                    description: "",
                    image: "",
                    path: "",
                    date: new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long" }),
                    likes: 0,
                    comments: [],
                },
                ...current.slides,
            ],
        }));
    };

    if (loading) {
        return <div className="p-10 text-center text-slate-500">Cargando ajustes de RH...</div>;
    }

    return (
        <div className="mx-auto max-w-6xl pb-10">
            <div className="mb-8 flex items-center justify-between gap-4">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
                        <Settings className="text-brand-600" />
                        Ajustes de Recursos Humanos
                    </h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Edita la apariencia del modulo RH y llena los bloques visibles del dashboard.
                    </p>
                </div>
                <button
                    onClick={handleSave}
                    disabled={saving || isUploading}
                    className="flex items-center gap-2 rounded-lg bg-brand-600 px-6 py-2 font-bold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-70"
                >
                    {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                    Guardar cambios
                </button>
            </div>

            <div className="space-y-8">
                <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
                    <div className="space-y-6 lg:col-span-1">
                        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                            <SectionHeader
                                icon={Settings}
                                title="Apariencia general"
                                description="Colores del marco, subtitulo y fondo principal del modulo."
                            />

                            <div className="mt-6 space-y-5">
                                <div>
                                    <span className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                        Color del marco
                                    </span>
                                    <div className="flex items-center gap-4">
                                        <input
                                            type="color"
                                            value={form.hrColor}
                                            onChange={(event) => updateField("hrColor", event.target.value)}
                                            className="h-10 w-16 cursor-pointer rounded border-0 p-0"
                                        />
                                        <input
                                            type="text"
                                            value={form.hrColor}
                                            onChange={(event) => updateField("hrColor", event.target.value)}
                                            className="flex-1 rounded-lg border border-slate-300 p-2 font-mono text-sm uppercase"
                                            maxLength={7}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    <label className="block">
                                        <span className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                            Fondo principal inicio
                                        </span>
                                        <div className="flex items-center gap-3">
                                            <input
                                                type="color"
                                                value={form.hrPageBgFrom}
                                                onChange={(event) => updateField("hrPageBgFrom", event.target.value)}
                                                className="h-10 w-14 cursor-pointer rounded border-0 p-0"
                                            />
                                            <input
                                                type="text"
                                                value={form.hrPageBgFrom}
                                                onChange={(event) => updateField("hrPageBgFrom", event.target.value)}
                                                className="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 font-mono text-sm uppercase"
                                                maxLength={7}
                                            />
                                        </div>
                                    </label>

                                    <label className="block">
                                        <span className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                            Fondo principal fin
                                        </span>
                                        <div className="flex items-center gap-3">
                                            <input
                                                type="color"
                                                value={form.hrPageBgTo}
                                                onChange={(event) => updateField("hrPageBgTo", event.target.value)}
                                                className="h-10 w-14 cursor-pointer rounded border-0 p-0"
                                            />
                                            <input
                                                type="text"
                                                value={form.hrPageBgTo}
                                                onChange={(event) => updateField("hrPageBgTo", event.target.value)}
                                                className="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 font-mono text-sm uppercase"
                                                maxLength={7}
                                            />
                                        </div>
                                    </label>
                                </div>

                                <div className="overflow-hidden rounded-xl border border-slate-200">
                                    <div
                                        className="h-20 w-full"
                                        style={{
                                            backgroundImage: `linear-gradient(180deg, ${form.hrPageBgFrom}, ${form.hrPageBgTo})`,
                                        }}
                                    />
                                    <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                                        Vista previa del fondo del modulo RH
                                    </div>
                                </div>

                                <TextInput
                                    label='Subtitulo debajo de "Soporte RH"'
                                    value={form.hrSubtitle}
                                    onChange={(event) => updateField("hrSubtitle", event.target.value)}
                                    placeholder="Ej: Portal de Capital Humano"
                                />

                                <div className="border-t border-slate-100 pt-5">
                                    <label className="mb-2 flex cursor-pointer items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={form.hrBannerActive}
                                            onChange={(event) => updateField("hrBannerActive", event.target.checked)}
                                            className="rounded text-brand-600 focus:ring-brand-500"
                                        />
                                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                            Activar barra de anuncio
                                        </span>
                                    </label>
                                    <TextArea
                                        label="Texto del anuncio superior"
                                        value={form.hrBannerText}
                                        onChange={(event) => updateField("hrBannerText", event.target.value)}
                                        placeholder="Ej: Reunion general el viernes a las 4 pm."
                                        rows={2}
                                        disabled={!form.hrBannerActive}
                                    />
                                </div>

                                <div className="border-t border-slate-100 pt-5">
                                    <span className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                        Fondo del chat de menciones
                                    </span>
                                    <div className="flex flex-col gap-3">
                                        {form.chatBgImage ? (
                                            <>
                                                <div className="relative h-24 w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                                                    <img
                                                        src={form.chatBgImage}
                                                        alt="Fondo del chat"
                                                        className="h-full w-full"
                                                        style={{ objectFit: form.chatBgSize === "100% 100%" ? "fill" : form.chatBgSize }}
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => updateField("chatBgImage", "")}
                                                        className="absolute right-2 top-2 rounded-full bg-red-500 p-1 text-white"
                                                        title="Eliminar fondo"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                                <label className="block">
                                                    <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                                        Ajuste de imagen
                                                    </span>
                                                    <select
                                                        value={form.chatBgSize}
                                                        onChange={(event) => updateField("chatBgSize", event.target.value)}
                                                        className="w-full rounded-lg border border-slate-300 p-2 text-sm"
                                                    >
                                                        <option value="cover">Cover</option>
                                                        <option value="contain">Contain</option>
                                                        <option value="100% 100%">Stretch</option>
                                                    </select>
                                                </label>
                                            </>
                                        ) : null}

                                        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-4 text-slate-500 transition-colors hover:bg-slate-50 hover:text-brand-600">
                                            {uploadingKey === "chat-bg" ? <Loader2 className="animate-spin" size={18} /> : <Upload size={18} />}
                                            <span className="text-sm font-medium">
                                                {form.chatBgImage ? "Cambiar fondo" : "Subir imagen de fondo"}
                                            </span>
                                            <input
                                                type="file"
                                                className="hidden"
                                                accept="image/*"
                                                onChange={handleChatBgUpload}
                                                disabled={isUploading}
                                            />
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                            <SectionHeader
                                icon={Megaphone}
                                title="Vacaciones"
                                description="Texto principal y listado del bloque de vacaciones."
                                action={
                                    <button
                                        type="button"
                                        onClick={() => addCollectionItem("vacationsItems", createVacationItem)}
                                        className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                                    >
                                        <Plus size={14} />
                                        Agregar
                                    </button>
                                }
                            />

                            <div className="mt-5 space-y-4">
                                <TextInput
                                    label="Titulo del bloque"
                                    value={form.vacationsTitle}
                                    onChange={(event) => updateField("vacationsTitle", event.target.value)}
                                    placeholder="Vacaciones del mes"
                                />

                                {form.vacationsItems.map((item) => (
                                    <div key={item.id} className="rounded-xl border border-slate-200 p-4">
                                        <div className="mb-3 flex items-center justify-between">
                                            <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Elemento</span>
                                            <button
                                                type="button"
                                                onClick={() => removeCollectionItem("vacationsItems", item.id)}
                                                className="text-slate-400 transition-colors hover:text-red-500"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <TextInput
                                                label="Nombre"
                                                value={item.name}
                                                onChange={(event) =>
                                                    updateCollectionItem("vacationsItems", item.id, { name: event.target.value })
                                                }
                                                placeholder="Nombre del colaborador"
                                            />
                                            <TextInput
                                                label="Departamento"
                                                value={item.department}
                                                onChange={(event) =>
                                                    updateCollectionItem("vacationsItems", item.id, { department: event.target.value })
                                                }
                                                placeholder="Area o departamento"
                                            />
                                        </div>
                                        <TextInput
                                            label="Fechas"
                                            value={item.dates}
                                            onChange={(event) =>
                                                updateCollectionItem("vacationsItems", item.id, { dates: event.target.value })
                                            }
                                            placeholder="Del 10 al 12 de marzo"
                                            className="mt-3"
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div className="space-y-6 lg:col-span-2">
                        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                            <SectionHeader
                                icon={Gift}
                                title="Cumpleanos"
                                description="Personas destacadas en el bloque lateral."
                                action={
                                    <button
                                        type="button"
                                        onClick={() => addCollectionItem("birthdaysItems", createBirthdayItem)}
                                        className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                                    >
                                        <Plus size={14} />
                                        Agregar
                                    </button>
                                }
                            />

                            <div className="mt-5 space-y-4">
                                <TextInput
                                    label="Titulo del bloque"
                                    value={form.birthdaysTitle}
                                    onChange={(event) => updateField("birthdaysTitle", event.target.value)}
                                    placeholder="Cumpleanos FLC"
                                />

                                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                                    {form.birthdaysItems.map((item) => (
                                        <div key={item.id} className="rounded-xl border border-slate-200 p-4">
                                            <div className="mb-3 flex items-center justify-between">
                                                <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Cumpleanos</span>
                                                <button
                                                    type="button"
                                                    onClick={() => removeCollectionItem("birthdaysItems", item.id)}
                                                    className="text-slate-400 transition-colors hover:text-red-500"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                            <div className="space-y-3">
                                                <TextInput
                                                    label="Nombre"
                                                    value={item.name}
                                                    onChange={(event) =>
                                                        updateCollectionItem("birthdaysItems", item.id, { name: event.target.value })
                                                    }
                                                    placeholder="Nombre del colaborador"
                                                />
                                                <TextInput
                                                    label="Departamento"
                                                    value={item.department}
                                                    onChange={(event) =>
                                                        updateCollectionItem("birthdaysItems", item.id, { department: event.target.value })
                                                    }
                                                    placeholder="Area o departamento"
                                                />
                                                <TextInput
                                                    label="Fecha visible"
                                                    value={item.date}
                                                    onChange={(event) =>
                                                        updateCollectionItem("birthdaysItems", item.id, { date: event.target.value })
                                                    }
                                                    placeholder="15 de marzo"
                                                />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                            <SectionHeader
                                icon={Trophy}
                                title="Aniversarios"
                                description="Listado lateral con anios y fecha visible."
                                action={
                                    <button
                                        type="button"
                                        onClick={() => addCollectionItem("anniversariesItems", createAnniversaryItem)}
                                        className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                                    >
                                        <Plus size={14} />
                                        Agregar
                                    </button>
                                }
                            />

                            <div className="mt-5 space-y-4">
                                <TextInput
                                    label="Titulo del bloque"
                                    value={form.anniversariesTitle}
                                    onChange={(event) => updateField("anniversariesTitle", event.target.value)}
                                    placeholder="Aniversarios FLC"
                                />

                                <div className="space-y-4">
                                    {form.anniversariesItems.map((item) => (
                                        <div key={item.id} className="rounded-xl border border-slate-200 p-4">
                                            <div className="mb-3 flex items-center justify-between">
                                                <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Aniversario</span>
                                                <button
                                                    type="button"
                                                    onClick={() => removeCollectionItem("anniversariesItems", item.id)}
                                                    className="text-slate-400 transition-colors hover:text-red-500"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_120px_1fr]">
                                                <TextInput
                                                    label="Nombre"
                                                    value={item.name}
                                                    onChange={(event) =>
                                                        updateCollectionItem("anniversariesItems", item.id, { name: event.target.value })
                                                    }
                                                    placeholder="Nombre del colaborador"
                                                />
                                                <TextInput
                                                    label="Anios"
                                                    value={item.years}
                                                    onChange={(event) =>
                                                        updateCollectionItem("anniversariesItems", item.id, { years: event.target.value })
                                                    }
                                                    placeholder="4"
                                                />
                                                <TextInput
                                                    label="Fecha visible"
                                                    value={item.date}
                                                    onChange={(event) =>
                                                        updateCollectionItem("anniversariesItems", item.id, { date: event.target.value })
                                                    }
                                                    placeholder="05 noviembre 2026"
                                                />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                            <SectionHeader
                                icon={Megaphone}
                                title="Anuncios"
                                description="Cada anuncio puede llevar una imagen y dos lineas de texto."
                                action={
                                    <button
                                        type="button"
                                        onClick={() => addCollectionItem("announcementsItems", createAnnouncementItem)}
                                        className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                                    >
                                        <Plus size={14} />
                                        Agregar
                                    </button>
                                }
                            />

                            <div className="mt-5 space-y-4">
                                <TextInput
                                    label="Titulo del bloque"
                                    value={form.announcementsTitle}
                                    onChange={(event) => updateField("announcementsTitle", event.target.value)}
                                    placeholder="Anuncios Grupo FLC"
                                />

                                <div className="space-y-4">
                                    {form.announcementsItems.map((item) => (
                                        <div key={item.id} className="rounded-xl border border-slate-200 p-4">
                                            <div className="mb-4 flex items-center justify-between">
                                                <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Anuncio</span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDeleteAnnouncement(item)}
                                                    className="text-slate-400 transition-colors hover:text-red-500"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                                                <div className="space-y-3">
                                                    <div className="relative aspect-[4/5] overflow-hidden rounded-xl border-2 border-dashed border-slate-200 bg-slate-100">
                                                        {item.image ? (
                                                            <img src={item.image} alt={item.title || "Anuncio RH"} className="h-full w-full object-cover" />
                                                        ) : (
                                                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                                                                <ImageIcon size={28} />
                                                                <span className="mt-2 text-xs font-medium">Sin imagen</span>
                                                            </div>
                                                        )}

                                                        <label className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-black/45 text-white opacity-0 transition-opacity hover:opacity-100">
                                                            {uploadingKey === `announcement-${item.id}` ? (
                                                                <Loader2 className="animate-spin" size={24} />
                                                            ) : (
                                                                <Upload size={22} />
                                                            )}
                                                            <span className="mt-2 text-xs font-bold">
                                                                {item.image ? "Cambiar foto" : "Subir foto"}
                                                            </span>
                                                            <input
                                                                type="file"
                                                                className="hidden"
                                                                accept="image/*"
                                                                disabled={isUploading}
                                                                onChange={(event) => handleAnnouncementUpload(event, item.id)}
                                                            />
                                                        </label>
                                                    </div>

                                                    {item.image ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveAnnouncementImage(item)}
                                                            className="w-full rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                                                        >
                                                            Quitar imagen
                                                        </button>
                                                    ) : null}
                                                </div>

                                                <div className="space-y-3">
                                                    <TextInput
                                                        label="Linea 1"
                                                        value={item.title}
                                                        onChange={(event) =>
                                                            updateCollectionItem("announcementsItems", item.id, { title: event.target.value })
                                                        }
                                                        placeholder="Titulo del anuncio"
                                                    />
                                                    <TextArea
                                                        label="Linea 2"
                                                        value={item.subtitle}
                                                        onChange={(event) =>
                                                            updateCollectionItem("announcementsItems", item.id, { subtitle: event.target.value })
                                                        }
                                                        placeholder="Descripcion corta o subtitulo"
                                                        rows={3}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                            <SectionHeader
                                icon={CalendarDays}
                                title="Noticias del carrusel"
                                description="Se mantiene editable desde aqui."
                                action={
                                    <button
                                        type="button"
                                        onClick={handleAddSlide}
                                        className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
                                    >
                                        <Plus size={14} />
                                        Agregar
                                    </button>
                                }
                            />

                            <div className="mt-5 space-y-4">
                                {form.slides.length === 0 ? (
                                    <div className="rounded-xl border-2 border-dashed border-slate-200 py-12 text-center text-slate-400">
                                        <ImageIcon size={40} className="mx-auto mb-3 opacity-50" />
                                        <p>No hay noticias en el carrusel.</p>
                                    </div>
                                ) : (
                                    form.slides.map((slide) => (
                                        <div key={slide.id} className="rounded-xl border border-slate-200 p-4">
                                            <div className="mb-4 flex items-center justify-between">
                                                <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Slide</span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDeleteSlide(slide)}
                                                    className="text-slate-400 transition-colors hover:text-red-500"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                                                <div className="space-y-2">
                                                    <div className="relative aspect-video overflow-hidden rounded-lg border-2 border-dashed border-slate-200 bg-slate-100">
                                                        {slide.image ? (
                                                            <img src={slide.image} alt={slide.title} className="h-full w-full object-cover" />
                                                        ) : (
                                                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                                                                <ImageIcon size={24} />
                                                                <span className="mt-1 text-xs font-medium">Sin imagen</span>
                                                            </div>
                                                        )}

                                                        <label className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-black/45 text-white opacity-0 transition-opacity hover:opacity-100">
                                                            {uploadingKey === `slide-${slide.id}` ? (
                                                                <Loader2 className="animate-spin" size={24} />
                                                            ) : (
                                                                <Upload size={22} />
                                                            )}
                                                            <span className="mt-2 text-xs font-bold">Cambiar foto</span>
                                                            <input
                                                                type="file"
                                                                className="hidden"
                                                                accept="image/*"
                                                                disabled={isUploading}
                                                                onChange={(event) => handleSlideUpload(event, slide.id)}
                                                            />
                                                        </label>
                                                    </div>
                                                    <span className="block text-center text-[10px] text-slate-400">
                                                        {slide.comments?.length || 0} comentarios - {slide.likes || 0} me gusta
                                                    </span>
                                                </div>

                                                <div className="space-y-3">
                                                    <TextInput
                                                        label="Titulo"
                                                        value={slide.title}
                                                        onChange={(event) =>
                                                            updateCollectionItem("slides", slide.id, { title: event.target.value })
                                                        }
                                                        placeholder="Titulo principal"
                                                    />
                                                    <TextArea
                                                        label="Descripcion"
                                                        value={slide.description}
                                                        onChange={(event) =>
                                                            updateCollectionItem("slides", slide.id, { description: event.target.value })
                                                        }
                                                        placeholder="Breve descripcion del evento"
                                                        rows={3}
                                                    />
                                                    <TextInput
                                                        label="Fecha visible"
                                                        value={slide.date}
                                                        onChange={(event) =>
                                                            updateCollectionItem("slides", slide.id, { date: event.target.value })
                                                        }
                                                        placeholder="12 de marzo"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
