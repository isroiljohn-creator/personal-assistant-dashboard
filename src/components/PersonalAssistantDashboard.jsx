import React, { useMemo, useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { motion } from "framer-motion";
import {
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Filter,
  LayoutDashboard,
  ListTodo,
  Plus,
  Search,
  TriangleAlert,
  Wallet,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  CalendarClock,
  BellRing,
} from "lucide-react";

// API Base URL - relative in production, localhost in dev
const API_URL = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api';

const calendarItems = [
  { id: 1, time: "10:30", title: "Sales review", type: "meeting" },
  { id: 2, time: "14:00", title: "Azizga proposal yuborish", type: "deadline" },
  { id: 3, time: "18:00", title: "Virale karusel outline", type: "task" },
  { id: 4, time: "20:30", title: "Evening review", type: "review" },
];

const fmt = (num) => new Intl.NumberFormat("ru-RU").format(num);

const priorityStyles = {
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

const statusLabel = {
  todo: "To do",
  in_progress: "Jarayonda",
  done: "Tugagan",
};

export default function PersonalAssistantDashboard() {
  const [tasks, setTasks] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [txDialogOpen, setTxDialogOpen] = useState(false);
  
  const [newTask, setNewTask] = useState({
    title: "",
    project: "General",
    priority: "medium",
    due: "",
    nextAction: "",
  });
  
  const [newTx, setNewTx] = useState({
    type: "expense",
    title: "",
    category: "Personal",
    amount: "",
    currency: "UZS",
    date: new Date().toISOString().split('T')[0],
    wallet: "TBC Humo",
  });

  const fetchData = async () => {
    try {
      const res = await fetch(`${API_URL}/data`);
      if (!res.ok) throw new Error('API down');
      const data = await res.json();
      setTasks(data.tasks);
      setTransactions(data.transactions);
      setWallets(data.wallets);
    } catch(e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Poll every 5 seconds to sync with Telegram bot automatically
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(search.toLowerCase()) ||
        t.project.toLowerCase().includes(search.toLowerCase())
    );
  }, [tasks, search]);

  const overdueCount = tasks.filter((t) => t.overdue && t.status !== "done").length;
  const openTasks = tasks.filter((t) => t.status !== "done").length;
  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const highPriorityCount = tasks.filter((t) => t.priority === "high" && t.status !== "done").length;

  const uzsIncome = transactions
    .filter((t) => t.type === "income" && t.currency === "UZS")
    .reduce((sum, t) => sum + t.amount, 0);
  const uzsExpense = transactions
    .filter((t) => t.type === "expense" && t.currency === "UZS")
    .reduce((sum, t) => sum + t.amount, 0);
  const usdIncome = transactions
    .filter((t) => t.type === "income" && t.currency === "USD")
    .reduce((sum, t) => sum + t.amount, 0);
  const usdExpense = transactions
    .filter((t) => t.type === "expense" && t.currency === "USD")
    .reduce((sum, t) => sum + t.amount, 0);

  const completionRate = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;

  const toggleTask = async (id) => {
    try {
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status: t.status === 'done' ? 'todo' : 'done', overdue: false } : t));
      await fetch(`${API_URL}/tasks/${id}/toggle`, { method: 'PATCH' });
    } catch (e) {
      console.error(e);
      fetchData(); // revert on fail
    }
  };

  const addTask = async () => {
    if (!newTask.title.trim()) return;
    try {
      const resp = await fetch(`${API_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTask)
      });
      const data = await resp.json();
      setTasks([data, ...tasks]);
      setNewTask({ title: "", project: "General", priority: "medium", due: "", nextAction: "" });
      setTaskDialogOpen(false);
    } catch(e) {
      console.error(e);
    }
  };

  const addTransaction = async () => {
    if (!newTx.title.trim() || !newTx.amount) return;
    try {
      const resp = await fetch(`${API_URL}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTx)
      });
      const data = await resp.json();
      setTransactions([data, ...transactions]);
      setNewTx({
        type: "expense",
        title: "",
        category: "Personal",
        amount: "",
        currency: "UZS",
        date: new Date().toISOString().split('T')[0],
        wallet: "TBC Humo",
      });
      setTxDialogOpen(false);
    } catch(e) {
      console.error(e);
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center dark:bg-slate-950 dark:text-slate-50"><span className="animate-pulse">Loading API...</span></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
      <div className="mx-auto max-w-7xl p-4 md:p-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
        >
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1">Personal OS</Badge>
              <Badge variant="secondary" className="rounded-full px-3 py-1 bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300">Telegram Bot Ulangan</Badge>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Shaxsiy assistent dashboard</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
              Vazifalar, deadlinelar, kirim-chiqim, hamyonlar va kunlik nazorat bitta joyda. Nihoyat kalendarga, note’ga, wallet app’ga yugurib yurish tugaydi.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
              <DialogTrigger asChild>
                <Button className="rounded-2xl"><Plus className="mr-2 h-4 w-4" /> Vazifa qo‘shish</Button>
              </DialogTrigger>
              <DialogContent className="rounded-3xl sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Yangi vazifa</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <Input placeholder="Vazifa nomi" value={newTask.title} onChange={(e) => setNewTask({ ...newTask, title: e.target.value })} />
                  <Input placeholder="Project" value={newTask.project} onChange={(e) => setNewTask({ ...newTask, project: e.target.value })} />
                  <Select value={newTask.priority} onValueChange={(value) => setNewTask({ ...newTask, priority: value })}>
                    <SelectTrigger><SelectValue placeholder="Priority" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input placeholder="Deadline" value={newTask.due} onChange={(e) => setNewTask({ ...newTask, due: e.target.value })} />
                  <Textarea placeholder="Keyingi aniq qadam" value={newTask.nextAction} onChange={(e) => setNewTask({ ...newTask, nextAction: e.target.value })} />
                  <Button onClick={addTask} className="mt-2">Saqlash</Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={txDialogOpen} onOpenChange={setTxDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="rounded-2xl"><CircleDollarSign className="mr-2 h-4 w-4" /> Kirim / chiqim</Button>
              </DialogTrigger>
              <DialogContent className="rounded-3xl sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Yangi tranzaksiya</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <Select value={newTx.type} onValueChange={(value) => setNewTx({ ...newTx, type: value })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="income">Kirim</SelectItem>
                      <SelectItem value="expense">Chiqim</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input placeholder="Nomi" value={newTx.title} onChange={(e) => setNewTx({ ...newTx, title: e.target.value })} />
                  <Input placeholder="Kategoriya" value={newTx.category} onChange={(e) => setNewTx({ ...newTx, category: e.target.value })} />
                  <Input placeholder="Summasi" type="number" value={newTx.amount} onChange={(e) => setNewTx({ ...newTx, amount: e.target.value })} />
                  <Select value={newTx.currency} onValueChange={(value) => setNewTx({ ...newTx, currency: value })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="UZS">UZS</SelectItem>
                      <SelectItem value="USD">USD</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input placeholder="Sana" value={newTx.date} onChange={(e) => setNewTx({ ...newTx, date: e.target.value })} />
                  <Input placeholder="Hamyon" value={newTx.wallet} onChange={(e) => setNewTx({ ...newTx, wallet: e.target.value })} />
                  <Button onClick={addTransaction} className="mt-2">Saqlash</Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </motion.div>

        <div className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            { title: "Ochiq vazifalar", value: openTasks, icon: ListTodo, note: `${highPriorityCount} tasi high priority` },
            { title: "Kechikkan deadline", value: overdueCount, icon: TriangleAlert, note: "Zudlik bilan yopilishi kerak", highlight: overdueCount > 0 },
            { title: "Task completion", value: `${completionRate}%`, icon: CheckCircle2, note: `${doneTasks} task tugatilgan` },
            { title: "Bugungi reja", value: calendarItems.length, icon: CalendarClock, note: "Bugun jadvalda faol kun" },
          ].map((item, idx) => (
            <motion.div key={item.title} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 + 0.1 }}>
              <Card className={`rounded-3xl border ${item.highlight ? 'border-destructive/50 shadow-destructive/10' : 'border-slate-200 dark:border-slate-800'} shadow-sm relative overflow-hidden`}>
                <CardContent className="p-6">
                  {item.highlight && <div className="absolute top-0 right-0 w-16 h-16 bg-destructive/10 -mr-8 -mt-8 rounded-full blur-xl" />}
                  <div className="mb-4 flex items-center justify-between relative z-10">
                    <div className={`rounded-2xl p-3 ${item.highlight ? 'bg-destructive/10 text-destructive' : 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300'}`}>
                      <item.icon className="h-5 w-5" />
                    </div>
                    <Badge variant="outline" className="rounded-full bg-white/50 dark:bg-slate-950/50 backdrop-blur-sm">Live</Badge>
                  </div>
                  <div className="relative z-10">
                    <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{item.title}</div>
                    <div className="mt-1 text-3xl font-bold tracking-tight">{item.value}</div>
                    <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{item.note}</div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="flex w-full md:w-auto overflow-x-auto justify-start md:justify-center rounded-2xl bg-white p-1.5 shadow-sm dark:bg-slate-900 border dark:border-slate-800">
            <TabsTrigger value="overview" className="rounded-xl px-4 py-2"><LayoutDashboard className="mr-2 h-4 w-4" /> Overview</TabsTrigger>
            <TabsTrigger value="tasks" className="rounded-xl px-4 py-2"><ListTodo className="mr-2 h-4 w-4" /> Vazifalar</TabsTrigger>
            <TabsTrigger value="finance" className="rounded-xl px-4 py-2"><Wallet className="mr-2 h-4 w-4" /> Moliya</TabsTrigger>
            <TabsTrigger value="calendar" className="rounded-xl px-4 py-2"><CalendarDays className="mr-2 h-4 w-4" /> Kalendar</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="focus-visible:outline-none focus-visible:ring-0 mt-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-6 xl:grid-cols-[1fr_350px]">
              <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                <CardHeader className="pb-4">
                  <CardTitle className="text-xl">Bugungi fokus</CardTitle>
                  <CardDescription>Eng muhim tasklar. 17 ta emas, normal odamga yetadigan miqdor.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {tasks.slice(0, 3).map((task) => (
                      <motion.div whileHover={{ scale: 1.01 }} key={task.id} className="group rounded-2xl border bg-card p-4 transition-all hover:shadow-md dark:border-slate-800">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="flex items-start gap-3">
                            <Checkbox checked={task.status === "done"} onCheckedChange={() => toggleTask(task.id)} className="mt-1 h-5 w-5 rounded-md" />
                            <div>
                              <div className={`font-medium ${task.status === 'done' ? 'line-through text-slate-400' : ''}`}>{task.title}</div>
                              <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{task.nextAction}</div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Badge variant={priorityStyles[task.priority]} className="rounded-lg">{task.priority}</Badge>
                                <Badge variant="outline" className="rounded-lg bg-slate-50 dark:bg-slate-900">{task.project}</Badge>
                                <Badge variant="secondary" className="rounded-lg">{statusLabel[task.status]}</Badge>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                            <CalendarClock className="h-4 w-4 opacity-50" />
                            {task.due}
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6">
                <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-xl">Progress</CardTitle>
                    <CardDescription>Ochig‘i, shu chiziq ko‘tarilsa kayfiyat ham ko‘tariladi.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-3 flex items-center justify-between text-sm font-medium">
                      <span className="text-slate-600 dark:text-slate-300">Task completion</span>
                      <span className="text-primary">{completionRate}%</span>
                    </div>
                    <Progress value={completionRate} className="h-3 rounded-full bg-slate-100 dark:bg-slate-800" />
                  </CardContent>
                </Card>

                <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-xl">Tez signal</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {overdueCount > 0 && (
                      <div className="flex items-start gap-3 rounded-2xl bg-amber-50/80 p-4 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 border border-amber-100 dark:border-amber-900/50">
                        <BellRing className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>{overdueCount} ta kechikkan task hozir yopilsa eng katta bosim tushadi.</div>
                      </div>
                    )}
                    <div className="flex items-start gap-3 rounded-2xl bg-emerald-50/80 p-4 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200 border border-emerald-100 dark:border-emerald-900/50">
                      <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>Bugungi kirim/chiqim va tasklar bitta panelda turibdi.</div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          </TabsContent>

          <TabsContent value="tasks" className="focus-visible:outline-none focus-visible:ring-0 mt-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-6 xl:grid-cols-[1fr_350px]">
              <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                <CardHeader className="gap-4 flex-col md:flex-row md:items-center md:justify-between pb-6">
                  <div>
                    <CardTitle className="text-xl">Vazifalar markazi</CardTitle>
                    <CardDescription className="max-w-md">Task, deadline, next action. Shuncha narsa bitta joyda bo‘lsa odamning miyasi kamroq qochadi.</CardDescription>
                  </div>
                  <div className="flex w-full gap-3 md:w-auto relative z-20">
                    <div className="relative w-full md:w-72">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Task qidirish..." className="rounded-xl pl-9 bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 focus-visible:ring-primary h-10" />
                    </div>
                    <Button variant="outline" className="rounded-xl px-3 h-10 border-slate-200 dark:border-slate-800"><Filter className="h-4 w-4 text-slate-500" /></Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[600px] pr-4 -mr-4">
                    <div className="space-y-3 pb-6">
                      {filteredTasks.map((task) => (
                        <motion.div
                          key={task.id}
                          layout
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className={`group rounded-2xl border p-5 transition-all hover:shadow-md ${task.overdue && task.status !== 'done' ? 'border-destructive/30 bg-destructive/5 dark:bg-destructive/10' : 'bg-card border-slate-200 dark:border-slate-800'}`}
                        >
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="flex items-start gap-4">
                              <Checkbox checked={task.status === "done"} onCheckedChange={() => toggleTask(task.id)} className="mt-1 h-5 w-5 rounded-md" />
                              <div>
                                <div className={`text-base font-medium ${task.status === 'done' ? 'line-through text-slate-400' : 'text-slate-900 dark:text-slate-100'}`}>{task.title}</div>
                                <div className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{task.nextAction}</div>
                                <div className="mt-4 flex flex-wrap gap-2.5">
                                  <Badge variant={priorityStyles[task.priority]} className="rounded-lg px-2.5 py-0.5">{task.priority}</Badge>
                                  <Badge variant="outline" className="rounded-lg px-2.5 py-0.5 bg-background">{task.project}</Badge>
                                  <Badge variant="secondary" className="rounded-lg px-2.5 py-0.5">{statusLabel[task.status]}</Badge>
                                  {task.overdue && task.status !== 'done' && <Badge variant="destructive" className="rounded-lg px-2.5 py-0.5 shadow-sm">Kechikkan</Badge>}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 text-sm font-medium text-slate-500 lg:justify-end">
                              <CalendarDays className="h-4 w-4 opacity-50" />
                              {task.due}
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800 h-fit sticky top-6">
                <CardHeader className="pb-4">
                  <CardTitle className="text-xl">Deadline nazorati</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {tasks
                    .filter((task) => (task.overdue || task.priority === "high") && task.status !== "done")
                    .map((task) => (
                      <div key={task.id} className="rounded-2xl border p-4 bg-slate-50 dark:bg-slate-900/50 dark:border-slate-800">
                        <div className="font-medium text-sm">{task.title}</div>
                        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 font-medium">{task.due}</div>
                      </div>
                    ))}
                    {tasks.filter((t) => (t.overdue || t.priority === "high") && t.status !== "done").length === 0 && (
                      <div className="text-sm text-slate-500 text-center py-6">Hammasi joyida.</div>
                    )}
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          <TabsContent value="finance" className="focus-visible:outline-none focus-visible:ring-0 mt-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-6 xl:grid-cols-[1fr_380px]">
              <div className="grid gap-6">
                <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-xl">Kirim / chiqimlar</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {transactions.map((tx) => (
                        <div key={tx.id} className="flex items-center justify-between rounded-2xl border p-4 bg-card dark:border-slate-800">
                          <div className="flex items-center gap-4">
                            <div className={`p-2.5 rounded-xl ${tx.type === "income" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400" : "bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400"}`}>
                              {tx.type === "income" ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                            </div>
                            <div>
                              <div className="font-medium text-slate-900 dark:text-slate-100">{tx.title}</div>
                              <div className="mt-0.5 text-sm font-medium text-slate-500 dark:text-slate-400">{tx.category} • {tx.date}</div>
                            </div>
                          </div>
                          <div className={`text-right font-bold text-lg ${tx.type === "income" ? "text-emerald-600 dark:text-emerald-500" : "text-rose-600 dark:text-rose-500"}`}>
                            {tx.type === "income" ? "+" : "-"}
                            {fmt(tx.amount)} {tx.currency === "UZS" ? "so'm" : "$"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
              <div className="grid gap-6">
                <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-xl">Hamyonlar</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {wallets.map((wallet) => (
                      <div key={wallet.id} className="rounded-2xl border p-5 bg-card dark:border-slate-800">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-slate-600 dark:text-slate-300">{wallet.name}</div>
                          <Badge variant="secondary" className="rounded-lg">{wallet.currency}</Badge>
                        </div>
                        <div className="mt-3 text-3xl font-bold tracking-tight">
                          {wallet.currency === "USD" ? "$" : ""}{fmt(wallet.balance)} <span className="text-lg font-medium text-slate-500">{wallet.currency === "UZS" ? "so'm" : ""}</span>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          </TabsContent>

          <TabsContent value="calendar" className="focus-visible:outline-none focus-visible:ring-0 mt-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
              <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-slate-200 dark:ring-slate-800">
                <CardHeader className="pb-6">
                  <CardTitle className="text-xl">Kunlik kalendar oqimi</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="relative space-y-6 before:absolute before:inset-0 before:ml-10 before:w-0.5 before:bg-slate-200 dark:before:bg-slate-800">
                    {calendarItems.map((item) => (
                      <div key={item.id} className="relative flex items-center justify-between md:justify-normal">
                        <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2rem)] p-4 rounded-2xl border bg-card dark:border-slate-800 ml-16 md:ml-20">
                          <div className="flex items-center justify-between mb-1">
                            <div className="font-bold text-slate-900 dark:text-slate-100">{item.time}</div>
                            <Badge variant="outline" className="text-xs">{item.type}</Badge>
                          </div>
                          <div className="text-sm font-medium text-slate-600 dark:text-slate-400">{item.title}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
