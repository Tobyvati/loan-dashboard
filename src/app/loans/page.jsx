'use client';

import React, { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@headlessui/react";
import { createClient } from "@supabase/supabase-js";

// =============================
// Supabase client (client-side, public anon key)
// =============================
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = (() => {
  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn("⚠️ Missing Supabase env: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
    }
    return createClient(supabaseUrl || "", supabaseAnonKey || "");
  } catch (e) {
    console.error("Failed to create Supabase client", e);
    return null;
  }
})();

// =============================
// Helpers (ASCII identifiers)
// =============================
// Format number with thousands separators (digits only input)
const formatNumber = (value) => {
  if (value === null || value === undefined || value === "") return "";
  const onlyDigits = String(value).replace(/\D/g, "");
  if (!onlyDigits) return "";
  return onlyDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

// Parse a currency-ish string to number safely
const parseCurrency = (str) => {
  if (str === null || str === undefined || str === "") return 0;
  const cleaned = String(str).replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "-") return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
};

// Human-friendly number for vi-VN
const fmt = (n) => {
  if (n === null || n === undefined || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return num.toLocaleString("vi-VN");
};

// Contract ID display as 6 digits (pad with zeros)
const fmtContractId = (v) => {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v).replace(/\D/g, "");
  return s.padStart(6, "0").slice(-6);
};

// =============================
// Random contractId generator + unique violation detector
// =============================
// =============================
const genRandomContractId = (takenIds, digits = 6) => {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  for (let i = 0; i < 100; i++) {
    const n = Math.floor(Math.random() * (max - min + 1)) + min;
    if (!takenIds.has(n)) return n;
  }
  // Fallback (hiếm): dựa vào time để vẫn đúng số chữ số
  const now = Date.now() % (max - min + 1);
  return Math.max(min, Math.min(max, now + min));
};

const isUniqueViolation = (err) => {
  const msg = String(err?.message || err?.details || "");
  return err?.code === '23505' || /duplicate key value/i.test(msg) || /unique constraint/i.test(msg);
};

// =============================
// DB column name adapters (fix mismatches like givenAmount vs givenamount)
// =============================
const camelToSnake = (s) => s.replace(/([A-Z])/g, "_$1").toLowerCase();
const camelToLower = (s) => s.toLowerCase();
const mapKeys = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [fn(k), v]));

// Determine how DB names columns. We'll support three modes:
// 'camel'  => loanAmount, givenAmount, startDate, ... (recommended)
// 'lower'  => loanamount, givenamount, startdate, ... (Postgres lowercased)
// 'snake'  => loan_amount, given_amount, start_date, ...
const detectDbModeFromRow = (row) => {
  if (!row) return 'camel';
  if ('givenAmount' in row) return 'camel';
  if ('given_amount' in row) return 'snake';
  if ('givenamount' in row) return 'lower';
  return 'camel';
};

const unifyLoanRow = (r) => ({
  contractId: r.contractId ?? r.contract_id ?? r.id ?? null,
  name: r.name ?? r.Name ?? "",
  phone: r.phone ?? r.Phone ?? "",
  imei: r.imei ?? r.IMEI ?? "",
  loanAmount: r.loanAmount ?? r.loan_amount ?? r.loanamount ?? 0,
  givenAmount: r.givenAmount ?? r.given_amount ?? r.givenamount ?? 0,
  paidTotal: r.paidTotal ?? r.paid_total ?? r.paidtotal ?? 0,
  repayAmount: r.repayAmount ?? r.repay_amount ?? r.repayamount ?? 0,
  loanDays: r.loanDays ?? r.loan_days ?? r.loandays ?? 0,
  payInterval: r.payInterval ?? r.pay_interval ?? r.payinterval ?? 0,
  startDate: r.startDate ?? r.start_date ?? r.startdate ?? "",
  status: r.status ?? r.Status ?? "Đang vay",
  history: Array.isArray(r.history) ? r.history : [],
});

const mapPayloadToDb = (payload, mode) => {
  if (mode === 'camel') return payload;
  if (mode === 'snake') return mapKeys(payload, camelToSnake);
  if (mode === 'lower') return mapKeys(payload, camelToLower);
  return payload;
};

// =============================
// Next-due calculation (reworked)
// =============================
const getDueStatus = (startDateStr, intervalDays, totalDays, givenAmount, paidTotal) => {
  if (!startDateStr || !intervalDays) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const start = new Date(startDateStr);
  if (Number.isNaN(start.getTime())) return null;
  const today = new Date();
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) return null;
  const d0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const dT = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysPassed = Math.max(0, Math.floor((dT - d0) / msPerDay));
  const expectedDueCycles = Math.floor(daysPassed / intervalDays);
  const maxCycles = totalDays && Number.isFinite(totalDays) && totalDays > 0 ? Math.ceil(totalDays / intervalDays) : Infinity;
  const perCycleAmt = totalDays > 0 && intervalDays > 0 ? Math.ceil((givenAmount || 0) * intervalDays / totalDays) : 0;
  const cyclesPaidEq = perCycleAmt > 0 ? Math.floor((paidTotal || 0) / perCycleAmt) : 0;
  let nextUnpaidDueDate = null;
  if (Number.isFinite(maxCycles) && cyclesPaidEq >= maxCycles) nextUnpaidDueDate = null; else {
    nextUnpaidDueDate = new Date(d0);
    nextUnpaidDueDate.setDate(d0.getDate() + (cyclesPaidEq + 1) * intervalDays);
  }
  const diff = nextUnpaidDueDate ? Math.ceil((nextUnpaidDueDate - dT) / msPerDay) : null;
  const overdueCycles = Math.max((expectedDueCycles || 0) - (cyclesPaidEq || 0), 0);
  const suppressSoonWarning = cyclesPaidEq >= expectedDueCycles + 1;
  return { perCycleAmt, expectedDueCycles, cyclesPaidEq, maxCycles, nextUnpaidDueDate, diff, overdueCycles, suppressSoonWarning };
};

// =============================
// Component
// =============================
export default function LoanDashboard() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [isEdit, setIsEdit] = useState(false);
  const [editContractId, setEditContractId] = useState(null);
  const [payContractId, setPayContractId] = useState(null);
  const [loans, setLoans] = useState([]);
  const [nextContractId, setNextContractId] = useState(1);
  const [newContractId, setNewContractId] = useState(null);
  const [search, setSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [infoMsg, setInfoMsg] = useState("");
  const [user, setUser] = useState(null);
  const [authEmail, setAuthEmail] = useState("");
  const [dbMode, setDbMode] = useState('camel'); // 'camel' | 'snake' | 'lower'
  const [pkName, setPkName] = useState('contractId');
  const PER_PAGE = 10;

  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    imei: "",
    loanAmount: "",
    givenAmount: "",
    loanDays: "",
    payInterval: "",
    startDate: "",
  });

  const [payData, setPayData] = useState({ amount: "", date: "" });

  // =============================
  // Supabase CRUD helpers (with fallback for schema naming)
  // =============================
  const computeNextId = (rows) => rows.length ? Math.max(...rows.map(r => Number((r.contractId ?? r.contract_id ?? r.id) || 0))) + 1 : 1;

  const fetchLoans = async () => {
    if (!supabase) return;
    if (!user) { setLoans([]); setErrorMsg("Bạn cần đăng nhập để xem dữ liệu"); return; }
    setLoading(true); setErrorMsg("");
    const { data, error } = await supabase.from("loans").select("*");
    if (error) {
      console.error(error);
      setErrorMsg(`Tải dữ liệu thất bại: ${error?.message || error || 'Unknown error'}`);
      setLoading(false);
      return;
    }
    const normalized = (data || []).map(unifyLoanRow);
    // Detect DB mode + PK from first row if possible
    const sample = data?.[0];
    if (sample) {
      setDbMode(detectDbModeFromRow(sample));
      const pk = 'contractId' in sample ? 'contractId' : ('contract_id' in sample ? 'contract_id' : ('id' in sample ? 'id' : 'contractId'));
      setPkName(pk);
    }
    normalized.sort((a, b) => (Number(a.contractId || 0) - Number(b.contractId || 0)));
    setLoans(normalized);
    setNextContractId(computeNextId(normalized));
    setLoading(false);
  };

  const insertLoan = async (rowBase) => {
    // Thử nhiều lần nếu dính unique constraint (mã HĐ trùng)
    const modes = [dbMode, 'camel', 'lower', 'snake'];
    const MAX_ATTEMPTS = 7;
    let lastErr;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let retriedForUnique = false;
      for (const mode of modes) {
        try {
          const payload = mapPayloadToDb(rowBase, mode);
          const { data, error } = await supabase.from('loans').insert(payload).select();
          if (error) throw error;
          setDbMode(mode); // lock successful mode
          return data?.[0] ? unifyLoanRow(data[0]) : null;
        } catch (e) {
          lastErr = e;
          if (isUniqueViolation(e)) {
            // Sinh lại contractId và thử lại toàn bộ vòng lặp
            const taken = new Set(loans.map((l) => Number(l.contractId ?? l.contract_id ?? l.id) || 0));
            if (rowBase.contractId) taken.add(Number(rowBase.contractId));
            rowBase.contractId = genRandomContractId(taken, 6);
            retriedForUnique = true;
            break; // thoát vòng for(mode), quay lại for(attempt)
          }
          // Nếu không phải unique violation, thử mode tiếp theo
          continue;
        }
      }
      if (!retriedForUnique) break; // nếu không phải unique lỗi, thoát để throw
    }
    throw lastErr;
  };

  const updateLoanById = async (idValue, patch) => {
    const modes = [dbMode, 'camel', 'lower', 'snake'];
    let lastErr;
    const pk = pkName;
    for (const mode of modes) {
      try {
        const payload = mapPayloadToDb(patch, mode);
        const { data, error } = await supabase.from('loans').update(payload).eq(pk, idValue).select();
        if (error) throw error;
        setDbMode(mode);
        return data?.[0] ? unifyLoanRow(data[0]) : null;
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    throw lastErr;
  };

  const deleteAllLoans = async () => {
    if (!user) throw new Error('Bạn cần đăng nhập');
    const { error } = await supabase.from('loans').delete().eq('owner', user.id);
    if (error) throw error;
  };

  // Auth: get session + subscribe, then fetch on login
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
    })();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription?.unsubscribe();
  }, []);

  useEffect(() => {
    if (user) { setErrorMsg(""); fetchLoans(); } else { setLoans([]); }
  }, [user]);

  // =============================
  // Derived: totals, filtering, pagination
  // =============================
  const totalLoan = useMemo(() => loans.reduce((s, l) => s + (Number(l?.loanAmount) || 0), 0), [loans]);

  const filteredLoans = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return loans;
    return loans.filter((l) => {
      const raw = String(l.contractId || "");
      const pad = fmtContractId(l.contractId || "");
      return raw.includes(q) || pad.includes(q) || (l.name || "").toLowerCase().includes(q);
    });
  }, [loans, search]);

  const pageCount = Math.max(1, Math.ceil(filteredLoans.length / 10));
  useEffect(() => { if (currentPage > pageCount) setCurrentPage(1); }, [pageCount, currentPage]);
  const pageLoans = useMemo(() => {
    const start = (currentPage - 1) * 10;
    return filteredLoans.slice(start, start + 10);
  }, [filteredLoans, currentPage]);

  // Clear all data in DB (dangerous)
  const clearData = async () => {
    if (!supabase) return;
    if (!user) { setErrorMsg('Bạn cần đăng nhập'); return; }
    if (confirm("Bạn có chắc muốn xóa toàn bộ dữ liệu trong database?")) {
      try {
        await deleteAllLoans();
        setLoans([]);
        setNextContractId(1);
        setCurrentPage(1);
      } catch (e) {
        console.error(e);
        setErrorMsg(`Xóa thất bại: ${e?.message || e}`);
      }
    }
  };

  // -----------------------------
  // Change handlers
  // -----------------------------
  const handleChange = (e) => {
    let { name, value } = e.target;
    if (name === "loanAmount" || name === "givenAmount") value = formatNumber(value);
    setFormData((s) => ({ ...s, [name]: value }));
  };

  const resetForm = () => {
    setIsEdit(false);
    setEditContractId(null);
    setFormData({ name: "", phone: "", imei: "", loanAmount: "", givenAmount: "", loanDays: "", payInterval: "", startDate: "" });
  };

  const openCreate = () => {
    resetForm();
    // Sinh mã HĐ ngẫu nhiên 6 chữ số, không trùng trong danh sách hiện tại
    const taken = new Set(loans.map((l) => Number(l.contractId ?? l.contract_id ?? l.id) || 0));
    const rid = genRandomContractId(taken, 6);
    setNewContractId(rid);
    setIsFormOpen(true);
  };

  const openEdit = (loan) => {
    setIsEdit(true);
    setEditContractId(loan.contractId);
    setFormData({
      name: loan.name || "",
      phone: loan.phone || "",
      imei: loan.imei || "",
      loanAmount: formatNumber(loan.loanAmount),
      givenAmount: formatNumber(loan.givenAmount),
      loanDays: String(loan.loanDays || ""),
      payInterval: String(loan.payInterval || ""),
      startDate: loan.startDate || "",
    });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!supabase) return;
    if (!user) { setErrorMsg('Bạn cần đăng nhập'); return; }
    const loanAmountNum = parseCurrency(formData.loanAmount);
    const givenAmountNum = parseCurrency(formData.givenAmount);
    const loanDaysNum = parseInt(formData.loanDays || "0", 10) || 0;
    const payIntervalNum = parseInt(formData.payInterval || "0", 10) || 0;

    const base = {
      name: formData.name.trim(),
      phone: formData.phone.trim(),
      imei: formData.imei.trim(),
      loanAmount: loanAmountNum,
      givenAmount: givenAmountNum,
      paidTotal: 0,
      repayAmount: givenAmountNum,
      loanDays: loanDaysNum,
      payInterval: payIntervalNum,
      startDate: formData.startDate,
      status: "Đang vay",
      history: [],
      owner: user?.id,
    };

    try {
      if (isEdit && editContractId != null) {
        const patch = { ...base, status: base.repayAmount <= 0 ? "Đã tất toán" : "Đang vay" };
        const updated = await updateLoanById(editContractId, patch);
        if (updated) setLoans((prev) => prev.map((l) => (l.contractId === editContractId ? updated : l)));
      } else {
        const payload = { contractId: newContractId, ...base };
        const inserted = await insertLoan(payload);
        if (inserted) {
          setLoans((prev) => [...prev, inserted].sort((a, b) => (Number(a.contractId || 0) - Number(b.contractId || 0))));
          setNextContractId((n) => Math.max(n, (inserted.contractId || 0) + 1));
        }
      }
    } catch (e) {
      console.error(e);
      setErrorMsg(`Lưu HĐ thất bại: ${e?.message || e}`);
    }

    setIsFormOpen(false);
    resetForm();
  };

  const openPay = (contractId) => {
    setPayContractId(contractId);
    setPayData({ amount: "", date: new Date().toISOString().slice(0, 10) });
    setIsPayOpen(true);
  };

  const handleConfirmPay = async () => {
    if (!supabase) return;
    if (!user) { setErrorMsg('Bạn cần đăng nhập'); return; }
    const payAmount = parseCurrency(payData.amount);
    if (!payAmount || payAmount <= 0) return;
    try {
      const target = loans.find((l) => l.contractId === payContractId);
      if (!target) return;
      const newPaid = (target.paidTotal || 0) + payAmount;
      const newRemain = Math.max((target.givenAmount || 0) - newPaid, 0);
      const entry = { date: payData.date, amount: payAmount, remaining: newRemain };
      const newHistory = [...(target.history || []), entry];
      const patch = { paidTotal: newPaid, repayAmount: newRemain, status: newRemain <= 0 ? "Đã tất toán" : target.status, history: newHistory };
      const updated = await updateLoanById(payContractId, patch);
      if (updated) setLoans((prev) => prev.map((l) => (l.contractId === payContractId ? updated : l)));
    } catch (e) {
      console.error(e);
      setErrorMsg(`Thanh toán thất bại: ${e?.message || e}`);
    }
    setIsPayOpen(false);
    setPayContractId(null);
    setPayData({ amount: "", date: "" });
  };

  const closeContract = async (contractId) => {
    if (!supabase) return;
    if (!user) { setErrorMsg('Bạn cần đăng nhập'); return; }
    try {
      const updated = await updateLoanById(contractId, { status: "Đã đóng" });
      if (updated) setLoans((prev) => prev.map((l) => (l.contractId === contractId ? updated : l)));
    } catch (e) {
      console.error(e);
      setErrorMsg(`Đóng HĐ thất bại: ${e?.message || e}`);
    }
  };

  // -----------------------------
  // Warnings (list items: soon due or overdue)
  // -----------------------------
  const warnings = useMemo(() => {
    const items = [];
    loans.forEach((l) => {
      if (l.status !== "Đang vay") return;
      const info = getDueStatus(l.startDate, l.payInterval, l.loanDays, l.givenAmount, l.paidTotal);
      if (!info) return;
      if (info.overdueCycles > 0) {
        const daysText = info.diff !== null && info.diff < 0 ? `, trễ ${Math.abs(info.diff)} ngày` : "";
        items.push({ id: l.contractId, type: "overdue", text: `HĐ #${fmtContractId(l.contractId)}: quá ${info.overdueCycles} kỳ${daysText}` });
      } else if (!info.suppressSoonWarning && info.diff !== null && info.diff <= 3) {
        items.push({ id: l.contractId, type: "soon", text: `HĐ #${fmtContractId(l.contractId)}: còn ${info.diff} ngày đến hạn` });
      }
    });
    return items.sort((a, b) => (a.type === b.type ? 0 : a.type === "overdue" ? -1 : 1));
  }, [loans]);

  const getRowStyle = (loan) => {
    const info = getDueStatus(loan.startDate, loan.payInterval, loan.loanDays, loan.givenAmount, loan.paidTotal);
    if (!info) return "";
    if (loan.status !== "Đang vay") return "bg-gray-100";
    if (info.overdueCycles > 0) return "bg-red-100";
    if (!info.suppressSoonWarning && info.diff !== null && info.diff <= 3) return "bg-yellow-100";
    return "";
  };

  // -----------------------------
  // Dev self-tests (add tests for adapters)
  // -----------------------------
  useEffect(() => {
    const runSelfTests = () => {
      try {
        console.assert(formatNumber("1234567") === "1,234,567", "formatNumber basic");
        console.assert(parseCurrency("1.234.567 đ") === 1234567, "parseCurrency dots and symbol");
        const today = new Date();
        const start20 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 20).toISOString().slice(0, 10);
        const demo = getDueStatus(start20, 10, 30, 3000, 0);
        console.assert(demo && demo.perCycleAmt === 1000, "per-cycle=1000");
        console.assert(demo && demo.expectedDueCycles === 2, "expectedDueCycles should be 2 (20/10)");
        const demo2 = getDueStatus(start20, 10, 30, 3000, 1000);
        console.assert(demo2 && demo2.cyclesPaidEq === 1, "cyclesPaidEq=1");
        console.assert(fmtContractId(1) === '000001', 'fmtContractId pads to 6');
        console.assert(fmtContractId('987654') === '987654', 'fmtContractId keeps 6-digit');
        // Adapter tests
        console.assert(camelToSnake('givenAmount') === 'given_amount', 'camelToSnake works');
        console.assert(camelToLower('givenAmount') === 'givenamount', 'camelToLower works');
        const rowLower = { givenamount: 10, loanamount: 20, paidtotal: 5, repayamount: 15, loandays: 30, payinterval: 10, startdate: '2025-01-01', contract_id: 7 };
        const uni = unifyLoanRow(rowLower);
        console.assert(uni.givenAmount === 10 && uni.loanAmount === 20 && uni.contractId === 7, 'unifyLoanRow lower-case works');
        const snakePayload = mapPayloadToDb({ givenAmount: 5, owner: 'x' }, 'snake');
        console.assert('given_amount' in snakePayload && 'owner' in snakePayload, 'mapPayloadToDb owner passthrough');
      } catch (e) {
        console.warn("Self-tests failed:", e);
      }
    };
    runSelfTests();
  }, []);

  // Extra self-test for random contractId
  useEffect(() => {
    try {
      const taken = new Set([123456]);
      const r = genRandomContractId(taken, 6);
      console.assert(r !== 123456 && String(r).length === 6, 'random contractId unique & 6 digits');
    } catch {}
  }, []);

  // =============================
  // UI
  // =============================
  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <h1 className="text-2xl font-bold mb-4">📊 Quản lý người vay</h1>

      {/* Env warning */}
      {(!supabaseUrl || !supabaseAnonKey) && (
        <div className="mb-3 p-3 rounded border bg-yellow-50 text-yellow-800 text-sm">
          Thiếu cấu hình Supabase (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Vui lòng thêm vào .env.local và reload.
        </div>
      )}

      <div className="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button onClick={openCreate} disabled={!user}>+ Thêm người vay</Button>
          <Button variant="destructive" onClick={clearData} disabled={!user}>🗑 Xóa toàn bộ (DB)</Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="px-3 py-2 rounded-lg bg-white border shadow text-sm">
            <div className="font-semibold">Tổng số tiền cho vay</div>
            <div className="text-lg">{fmt(totalLoan)} đ</div>
          </div>
          <input type="text" placeholder="Tìm mã HĐ hoặc tên..." value={search} onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }} className="w-64 border p-2 rounded" />
        </div>
      </div>

      {/* Auth controls */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {user ? (
          <>
            <span className="text-sm text-gray-700">Đã đăng nhập: {user.email}</span>
            <Button variant="secondary" onClick={async ()=>{ try{ await supabase.auth.signOut(); }catch{} }}>Đăng xuất</Button>
          </>
        ) : (
          <form onSubmit={(e)=>{e.preventDefault(); (async()=>{ try{ setErrorMsg(""); setInfoMsg(""); if(!authEmail){ setErrorMsg('Nhập email để đăng nhập'); return;} const { error } = await supabase.auth.signInWithOtp({ email: authEmail, options: { emailRedirectTo: (process.env.NEXT_PUBLIC_SITE_URL || (typeof window!=='undefined' ? window.location.origin : undefined)) } }); if(error) throw error; setInfoMsg('Đã gửi link đăng nhập. Vui lòng kiểm tra email.'); } catch(e){ console.error(e); setErrorMsg(`Đăng nhập thất bại: ${e?.message || e}`);} })(); }} className="flex items-center gap-2">
            <input type="email" placeholder="Email để đăng nhập" value={authEmail} onChange={(e)=> setAuthEmail(e.target.value)} className="border p-2 rounded" />
            <Button type="submit">Gửi link đăng nhập</Button>
          </form>
        )}
      </div>

      {infoMsg && (<div className="mb-3 p-3 rounded border bg-emerald-50 text-emerald-800 text-sm">{infoMsg}</div>)}
      {errorMsg && (<div className="mb-3 p-3 rounded border bg-red-50 text-red-800 text-sm">{errorMsg}</div>)}
      {loading && (<div className="mb-3 p-3 rounded border bg-blue-50 text-blue-800 text-sm">Đang tải dữ liệu…</div>)}

      {warnings.length > 0 && (
        <div className="mt-4 p-4 rounded-lg shadow bg-white border">
          <div className="font-semibold mb-2">⚠️ Cảnh báo: có {warnings.length} hợp đồng sắp đến hạn hoặc đã quá hạn</div>
          <ul className="list-disc list-inside space-y-1 text-sm">
            {warnings.map((w) => (
              <li key={w.id} className={w.type === "overdue" ? "text-red-700" : "text-yellow-700"}>{w.text}</li>
            ))}
          </ul>
        </div>
      )}

      <Card className="mt-6">
        <CardContent>
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-200 text-left">
                  <th className="p-2">Mã HĐ</th>
                  <th className="p-2">Tên người vay</th>
                  <th className="p-2">SĐT</th>
                  <th className="p-2">IMEI</th>
                  <th className="p-2">Số tiền vay</th>
                  <th className="p-2">Số tiền đưa khách</th>
                  <th className="p-2">Còn phải trả</th>
                  <th className="p-2">Số ngày vay</th>
                  <th className="p-2">Bao nhiêu ngày đóng 1 lần</th>
                  <th className="p-2">Ngày bắt đầu vay</th>
                  <th className="p-2">Ngày đến hạn</th>
                  <th className="p-2">Tình trạng</th>
                  <th className="p-2">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {pageLoans.map((loan) => {
                  const info = getDueStatus(loan.startDate, loan.payInterval, loan.loanDays, loan.givenAmount, loan.paidTotal);
                  const dueDateStr = info && info.nextUnpaidDueDate ? info.nextUnpaidDueDate.toLocaleDateString("vi-VN") : (loan.repayAmount <= 0 ? "-" : "");
                  const perCycleShow = loan.loanDays > 0 && loan.payInterval > 0 ? Math.ceil((loan.givenAmount || 0) * loan.payInterval / loan.loanDays) : 0;
                  return (
                    <tr key={loan.contractId} className={`border-b ${getRowStyle(loan)}`}>
                      <td className="p-2">{fmtContractId(loan.contractId)}</td>
                      <td className="p-2">{loan.name}</td>
                      <td className="p-2">{loan.phone}</td>
                      <td className="p-2">{loan.imei}</td>
                      <td className="p-2">{fmt(loan.loanAmount)}</td>
                      <td className="p-2">{fmt(loan.givenAmount)}</td>
                      <td className="p-2">{fmt(loan.repayAmount)}</td>
                      <td className="p-2">{loan.loanDays}</td>
                      <td className="p-2">{loan.payInterval}{perCycleShow > 0 && (<span className="text-sm text-gray-600"> (≈ {fmt(perCycleShow)})</span>)}</td>
                      <td className="p-2">{loan.startDate}</td>
                      <td className="p-2">
                        {dueDateStr}{" "}
                        {loan.status === "Đang vay" && info && info.diff !== null && (
                          <>
                            {!info.suppressSoonWarning && (
                              <span className={`text-xs ${info.diff < 0 ? "text-red-600" : info.diff <= 3 ? "text-yellow-700" : "text-green-600"}`}>
                                {info.diff >= 0 ? `(còn ${info.diff} ngày)` : `(trễ ${Math.abs(info.diff)} ngày)`}
                              </span>
                            )}
                            {info.overdueCycles > 0 && (
                              <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-red-200 text-red-800 font-semibold align-middle inline-block">Quá {info.overdueCycles} kỳ</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="p-2">
                        {loan.status === "Đang vay" ? (
                          <span className="text-blue-600 font-medium">{loan.status}</span>
                        ) : loan.status === "Đã tất toán" ? (
                          <span className="text-green-600 font-medium">{loan.status}</span>
                        ) : (
                          <span className="text-gray-600 font-medium">{loan.status}</span>
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => openPay(loan.contractId)} disabled={!user}>Trả tiền vay</Button>
                          <Button size="sm" variant="secondary" onClick={() => openEdit(loan)} disabled={!user}>Sửa HĐ</Button>
                          <Button size="sm" variant="destructive" onClick={() => closeContract(loan.contractId)} disabled={!user}>Đóng HĐ</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {filteredLoans.length === 0 && (
                  <tr>
                    <td className="p-4 text-center text-gray-500" colSpan={13}>Chưa có dữ liệu</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-3">
              <div className="text-sm text-gray-600">Tổng: {filteredLoans.length} HĐ • Trang {currentPage}/{pageCount}</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>← Trước</Button>
                <Button size="sm" variant="secondary" onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))} disabled={currentPage >= pageCount}>Sau →</Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create/Edit dialog */}
      <Dialog open={isFormOpen} onClose={() => setIsFormOpen(false)} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="bg-white p-6 rounded-xl w-full max-w-3xl">
            <Dialog.Title className="text-xl font-semibold mb-4">{isEdit ? `Sửa hợp đồng #${fmtContractId(editContractId)}` : `Thêm người vay (#${newContractId ? fmtContractId(newContractId) : '......'})`}</Dialog.Title>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block mb-1">Mã hợp đồng</label>
                <input type="text" value={isEdit ? fmtContractId(editContractId) : (newContractId ? fmtContractId(newContractId) : '')} disabled className="w-full border p-2 rounded bg-gray-100" />
              </div>
              <div>
                <label className="block mb-1">Tên người vay</label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Số điện thoại</label>
                <input type="text" name="phone" value={formData.phone} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">IMEI</label>
                <input type="text" name="imei" value={formData.imei} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Số tiền vay</label>
                <input type="text" name="loanAmount" value={formData.loanAmount} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Số tiền đưa khách</label>
                <input type="text" name="givenAmount" value={formData.givenAmount} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Số ngày vay</label>
                <input type="number" name="loanDays" value={formData.loanDays} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Bao nhiêu ngày đóng 1 lần</label>
                <input type="number" name="payInterval" value={formData.payInterval} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Ngày bắt đầu vay</label>
                <input type="date" name="startDate" value={formData.startDate} onChange={handleChange} className="w-full border p-2 rounded" />
              </div>
            </div>
            <div className="mt-4 flex justify-end space-x-2">
              <Button variant="secondary" onClick={() => { setIsFormOpen(false); resetForm(); }}>Hủy</Button>
              <Button onClick={handleSubmit}>{isEdit ? "Lưu sửa" : "Lưu"}</Button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>

      {/* Pay dialog */}
      <Dialog open={isPayOpen} onClose={() => setIsPayOpen(false)} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="bg-white p-6 rounded-xl w-full max-w-md">
            <Dialog.Title className="text-lg font-semibold mb-4">Trả tiền vay</Dialog.Title>
            <div className="space-y-3">
              <div>
                <label className="block mb-1">Số tiền trả</label>
                <input type="text" value={payData.amount} onChange={(e) => setPayData((s) => ({ ...s, amount: formatNumber(e.target.value) }))} className="w-full border p-2 rounded" />
              </div>
              <div>
                <label className="block mb-1">Ngày trả</label>
                <input type="date" value={payData.date} onChange={(e) => setPayData((s) => ({ ...s, date: e.target.value }))} className="w-full border p-2 rounded" />
              </div>
              <div className="mt-2 p-2 bg-gray-50 rounded">
                <div className="font-medium mb-1">Lịch sử trả gần đây</div>
                <ul className="max-h-32 overflow-auto text-sm list-disc list-inside">
                  {loans.find((l) => l.contractId === payContractId)?.history?.slice().reverse().map((h, idx) => (
                    <li key={idx}>{h.date}: trả {fmt(h.amount)} (còn {fmt(h.remaining)})</li>
                  )) || <li>Chưa có</li>}
                </ul>
              </div>
            </div>
            <div className="mt-4 flex justify-end space-x-2">
              <Button variant="secondary" onClick={() => setIsPayOpen(false)}>Hủy</Button>
              <Button onClick={handleConfirmPay}>Xác nhận</Button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
    </div>
  );
}
